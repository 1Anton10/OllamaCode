/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../../nls.js';
import { Categories } from '../../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { IChatWidgetService } from '../chat.js';
import { registerOllamaCodeConfigSync } from '../widget/input/modelPicker/modelPickerModelConfig.js';

export const OLLAMA_BRIDGE_MODEL_CONFIG = 'ollamaCode.bridgeModelConfiguration';

type BridgeArgs = {
	readonly modelId?: string;
	readonly contextSize?: number;
	readonly thinkingEffort?: string;
};

function toIdentifier(modelId: string): string {
	const id = (modelId || '').replace(/^ollamacode\//, '');
	return id.includes('/') ? id : `ollamacode/${id}`;
}

function bareId(modelId: string): string {
	return (modelId || '').replace(/^ollamacode\//, '');
}

/** Settings panel → live chat Context chip (+ profile store). */
class BridgeModelConfigurationAction extends Action2 {
	constructor() {
		super({
			id: OLLAMA_BRIDGE_MODEL_CONFIG,
			title: localize2('ollamaCode.bridgeModelConfiguration', "OllamaCode: Bridge Model Configuration"),
			category: Categories.Developer,
			f1: false,
		});
	}

	async run(accessor: import('../../../../../platform/instantiation/common/instantiation.js').ServicesAccessor, args?: BridgeArgs): Promise<void> {
		if (!args?.modelId) {
			return;
		}
		const languageModels = accessor.get(ILanguageModelsService);
		const widgets = accessor.get(IChatWidgetService);
		const identifier = toIdentifier(args.modelId);
		const values: Record<string, unknown> = {};
		if (typeof args.contextSize === 'number' && args.contextSize > 0) {
			values.contextSize = args.contextSize;
		}
		if (args.thinkingEffort === 'auto' || args.thinkingEffort === 'on' || args.thinkingEffort === 'off') {
			values.thinkingEffort = args.thinkingEffort;
		}
		if (!Object.keys(values).length) {
			return;
		}

		await languageModels.setModelConfiguration(identifier, values);
		for (const w of widgets.getAllWidgets()) {
			try {
				await w.inputPart.applyModelConfiguration?.(identifier, values);
			} catch {
				/* older input without bridge method */
			}
		}
	}
}

/** Chat chip → extension settings (ollamaCode.models). */
class OllamaCodeModelConfigSyncContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.ollamaCodeModelConfigSync';

	constructor(@ICommandService commandService: ICommandService) {
		super();
		registerOllamaCodeConfigSync((model, values) => {
			const vendor = model.metadata.vendor;
			const id = model.metadata.id || bareId(model.identifier);
			if (vendor !== 'ollamacode' && !model.identifier.startsWith('ollamacode/')) {
				return;
			}
			void commandService.executeCommand('ollamaCode.syncFromChatModelConfiguration', {
				modelId: id,
				contextSize: values.contextSize,
				thinkingEffort: values.thinkingEffort,
			});
		});
		this._register({ dispose: () => registerOllamaCodeConfigSync(undefined) });
	}
}

registerAction2(BridgeModelConfigurationAction);
registerWorkbenchContribution2(OllamaCodeModelConfigSyncContribution.ID, OllamaCodeModelConfigSyncContribution, WorkbenchPhase.AfterRestored);
