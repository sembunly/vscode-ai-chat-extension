import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { extractCode } from '../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('contributes the chat commands', () => {
		const extension = vscode.extensions.all.find(
			(candidate) => candidate.packageJSON.name === 'sembunly-ai-chat',
		);
		assert.ok(extension, 'AI Chat extension was not loaded');

		const commands = extension.packageJSON.contributes.commands as Array<{ command: string }>;
		assert.ok(commands.some(({ command }) => command === 'ai-chat.openChat'));
		assert.ok(commands.some(({ command }) => command === 'ai-chat.setApiKey'));
		assert.ok(commands.some(({ command }) => command === 'ai-chat.explainSelection'));
		assert.ok(commands.some(({ command }) => command === 'ai-chat.fixSelection'));
		assert.ok(commands.some(({ command }) => command === 'ai-chat.generateCode'));
		assert.strictEqual(extension.packageJSON.contributes.views.aiChat[0].id, 'aiChat.sidebarView');
	});

	test('extracts generated code from a fenced block', () => {
		assert.strictEqual(extractCode('Use this:\n```ts\nconst ready = true;\n```'), 'const ready = true;');
		assert.strictEqual(extractCode('No code here'), undefined);
	});
});
