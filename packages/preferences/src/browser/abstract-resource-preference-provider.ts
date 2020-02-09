/********************************************************************************
 * Copyright (C) 2018 Ericsson and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-null/no-null */

import * as jsoncparser from 'jsonc-parser';
import { JSONExt } from '@phosphor/coreutils/lib/json';
import { inject, injectable, postConstruct } from 'inversify';
import { ResourceProvider } from '@theia/core/lib/common/resource';
import { MessageService } from '@theia/core/lib/common/message-service';
import { Disposable } from '@theia/core/lib/common/disposable';
import { PreferenceProvider, PreferenceSchemaProvider, PreferenceScope, PreferenceProviderDataChange, PreferenceService } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { PreferenceConfigurations } from '@theia/core/lib/browser/preferences/preference-configurations';
import { MonacoTextModelService } from '@theia/monaco/lib/browser/monaco-text-model-service';
import { MonacoEditorModel } from '@theia/monaco/lib/browser/monaco-editor-model';
import { MonacoWorkspace } from '@theia/monaco/lib/browser/monaco-workspace';

@injectable()
export abstract class AbstractResourcePreferenceProvider extends PreferenceProvider {

    protected preferences: { [key: string]: any } = {};
    protected reference: Promise<monaco.editor.IReference<MonacoEditorModel>>;

    @inject(PreferenceService) protected readonly preferenceService: PreferenceService;
    @inject(ResourceProvider) protected readonly resourceProvider: ResourceProvider;
    @inject(MessageService) protected readonly messageService: MessageService;
    @inject(PreferenceSchemaProvider) protected readonly schemaProvider: PreferenceSchemaProvider;

    @inject(PreferenceConfigurations)
    protected readonly configurations: PreferenceConfigurations;

    @inject(MonacoTextModelService)
    protected readonly textModelService: MonacoTextModelService;

    @inject(MonacoWorkspace)
    protected readonly workspace: MonacoWorkspace;

    @postConstruct()
    protected async init(): Promise<void> {
        const uri = this.getUri();

        // it is blocking till the preference service is initialized,
        // so first try to load from the underlying resource
        this.reference = this.textModelService.createModelReference(uri);

        // Try to read the initial content of the preferences.  The provider
        // becomes ready even if we fail reading the preferences, so we don't
        // hang the preference service.
        try {
            const resource = await this.resourceProvider(uri);
            try {
                const content = await resource.readContents();
                this.loadPreferences(content);
            } finally {
                resource.dispose();
            }
        } catch {
            /* no-op */
        } finally {
            this._ready.resolve();
        }

        const reference = await this.reference;
        if (this.toDispose.disposed) {
            reference.dispose();
        }
        this.toDispose.push(reference);
        this.toDispose.push(reference.object.onDidChangeContent(() => this.readPreferences()));
        this.toDispose.push(Disposable.create(() => this.reset()));
    }

    protected abstract getUri(): URI;
    protected abstract getScope(): PreferenceScope;

    getConfigUri(): URI;
    getConfigUri(resourceUri: string | undefined): URI | undefined;
    getConfigUri(resourceUri?: string): URI | undefined {
        if (!resourceUri) {
            return this.getUri();
        }
        return this.loaded && this.contains(resourceUri) ? this.getUri() : undefined;
    }

    contains(resourceUri: string | undefined): boolean {
        if (!resourceUri) {
            return true;
        }
        const domain = this.getDomain();
        if (!domain) {
            return true;
        }
        const resourcePath = new URI(resourceUri).path;
        return domain.some(uri => new URI(uri).path.relativity(resourcePath) >= 0);
    }

    getPreferences(resourceUri?: string): { [key: string]: any } {
        return this.loaded && this.contains(resourceUri) ? this.preferences : {};
    }

    async setPreference(key: string, value: any, resourceUri?: string): Promise<boolean> {
        if (!this.contains(resourceUri)) {
            return false;
        }
        const path = this.getPath(key);
        if (!path) {
            return false;
        }
        try {
            const reference = await this.reference;
            const content = reference.object.getText().trim();
            if (!content && value === undefined) {
                return true;
            }
            const textModel = reference.object.textEditorModel;
            const editOperations: monaco.editor.IIdentifiedSingleEditOperation[] = [];
            if (path.length || value !== undefined) {
                const { insertSpaces, tabSize, defaultEOL } = textModel.getOptions();
                for (const edit of jsoncparser.modify(content, path, value, {
                    formattingOptions: {
                        insertSpaces,
                        tabSize,
                        eol: defaultEOL === monaco.editor.DefaultEndOfLine.LF ? '\n' : '\r\n'
                    }
                })) {
                    const start = textModel.getPositionAt(edit.offset);
                    const end = textModel.getPositionAt(edit.offset + edit.length);
                    editOperations.push({
                        range: monaco.Range.fromPositions(start, end),
                        text: edit.content || null,
                        forceMoveMarkers: false
                    });
                }
            } else {
                editOperations.push({
                    range: textModel.getFullModelRange(),
                    text: null,
                    forceMoveMarkers: false
                });
            }
            await this.workspace.applyBackgroundEdit(reference.object, editOperations);
            return true;
        } catch (e) {
            const message = `Failed to update the value of '${key}' in '${this.getUri()}'.`;
            this.messageService.error(`${message} Please check if it is corrupted.`);
            console.error(`${message}`, e);
            return false;
        }
    }

    protected getPath(preferenceName: string): string[] | undefined {
        return [preferenceName];
    }

    protected async readPreferences(): Promise<void> {
        try {
            const reference = await this.reference;
            const newContent = reference.object.getText();
            this.loadPreferences(newContent);
        } catch (e) {
            console.error(`Failed to load preferences from '${this.getUri()}'.`, e);
        }
    }

    protected loaded = false;
    protected loadPreferences(content: string | undefined): void {
        this.loaded = content !== undefined;
        const newPrefs = content ? this.getParsedContent(content) : {};
        this.handlePreferenceChanges(newPrefs);
    }

    protected getParsedContent(content: string): { [key: string]: any } {
        const jsonData = this.parse(content);

        const preferences: { [key: string]: any } = {};
        if (typeof jsonData !== 'object') {
            return preferences;
        }
        // eslint-disable-next-line guard-for-in
        for (const preferenceName in jsonData) {
            const preferenceValue = jsonData[preferenceName];
            if (this.schemaProvider.testOverrideValue(preferenceName, preferenceValue)) {
                // eslint-disable-next-line guard-for-in
                for (const overriddenPreferenceName in preferenceValue) {
                    const overriddenValue = preferenceValue[overriddenPreferenceName];
                    preferences[`${preferenceName}.${overriddenPreferenceName}`] = overriddenValue;
                }
            } else {
                preferences[preferenceName] = preferenceValue;
            }
        }
        return preferences;
    }

    protected parse(content: string): any {
        content = content.trim();
        if (!content) {
            return undefined;
        }
        const strippedContent = jsoncparser.stripComments(content);
        return jsoncparser.parse(strippedContent);
    }

    protected handlePreferenceChanges(newPrefs: { [key: string]: any }): void {
        const oldPrefs = Object.assign({}, this.preferences);
        this.preferences = newPrefs;
        const prefNames = new Set([...Object.keys(oldPrefs), ...Object.keys(newPrefs)]);
        const prefChanges: PreferenceProviderDataChange[] = [];
        const uri = this.getUri();
        for (const prefName of prefNames.values()) {
            const oldValue = oldPrefs[prefName];
            const newValue = newPrefs[prefName];
            const schemaProperties = this.schemaProvider.getCombinedSchema().properties[prefName];
            if (schemaProperties) {
                const scope = schemaProperties.scope;
                // do not emit the change event if the change is made out of the defined preference scope
                if (!this.schemaProvider.isValidInScope(prefName, this.getScope())) {
                    console.warn(`Preference ${prefName} in ${uri} can only be defined in scopes: ${PreferenceScope.getScopeNames(scope).join(', ')}.`);
                    continue;
                }
            }
            if (newValue === undefined && oldValue !== newValue
                || oldValue === undefined && newValue !== oldValue // JSONExt.deepEqual() does not support handling `undefined`
                || !JSONExt.deepEqual(oldValue, newValue)) {
                prefChanges.push({
                    preferenceName: prefName, newValue, oldValue, scope: this.getScope(), domain: this.getDomain()
                });
            }
        }

        if (prefChanges.length > 0) { // do not emit the change event if the pref value is not changed
            this.emitPreferencesChangedEvent(prefChanges);
        }
    }

    protected reset(): void {
        const preferences = this.preferences;
        this.preferences = {};
        const changes: PreferenceProviderDataChange[] = [];
        for (const prefName of Object.keys(preferences)) {
            const value = preferences[prefName];
            if (value !== undefined) {
                changes.push({
                    preferenceName: prefName, newValue: undefined, oldValue: value, scope: this.getScope(), domain: this.getDomain()
                });
            }
        }
        if (changes.length > 0) {
            this.emitPreferencesChangedEvent(changes);
        }
    }

}

