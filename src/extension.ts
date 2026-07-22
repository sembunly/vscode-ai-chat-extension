import OpenAI from 'openai';
import * as vscode from 'vscode';

const API_KEY_SECRET = 'ai-chat.openaiApiKey';
const DEFAULT_MODEL = 'gpt-5.6-sol';

type ChatMessage = { role: 'user' | 'assistant'; content: string };
type CodeAction = 'explain' | 'fix' | 'generate';
type SelectionTarget = { uri: string; range: vscode.Range };

export function activate(context: vscode.ExtensionContext) {
	const provider = new ChatViewProvider(context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand('ai-chat.openChat', () => provider.reveal()),
		vscode.commands.registerCommand('ai-chat.setApiKey', () => setApiKey(context)),
		vscode.commands.registerCommand('ai-chat.explainSelection', () => provider.runCodeAction('explain')),
		vscode.commands.registerCommand('ai-chat.fixSelection', () => provider.runCodeAction('fix')),
		vscode.commands.registerCommand('ai-chat.generateCode', () => provider.runCodeAction('generate')),
	);
}

async function setApiKey(context: vscode.ExtensionContext): Promise<boolean> {
	const apiKey = await vscode.window.showInputBox({
		title: 'OpenAI API Key',
		prompt: 'Enter your OpenAI API key. It will be stored in VS Code SecretStorage.',
		password: true,
		ignoreFocusOut: true,
		placeHolder: 'sk-…',
	});
	if (!apiKey?.trim()) {
		return false;
	}
	await context.secrets.store(API_KEY_SECRET, apiKey.trim());
	vscode.window.showInformationMessage('OpenAI API key saved securely.');
	return true;
}

class ChatViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = 'aiChat.sidebarView';
	private view?: vscode.WebviewView;
	private readonly messages: ChatMessage[] = [];
	private busy = false;
	private pendingAction?: { display: string; prompt: string; target?: SelectionTarget };
	private abortController?: AbortController;
	private applyTarget?: SelectionTarget;
	private lastReply = '';

	constructor(private readonly context: vscode.ExtensionContext) {}

	resolveWebviewView(view: vscode.WebviewView) {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = buildWebviewHtml(view.webview);
		view.webview.onDidReceiveMessage(
			(message: { type?: string; text?: string; action?: CodeAction }) => this.handleMessage(message),
			undefined,
			this.context.subscriptions,
		);
		view.onDidDispose(() => {
			this.view = undefined;
			this.abortController?.abort();
		});

		if (this.pendingAction) {
			const pending = this.pendingAction;
			this.pendingAction = undefined;
			void this.send(pending.display, pending.prompt, pending.target);
		}
	}

	async reveal() {
		await vscode.commands.executeCommand('workbench.view.extension.aiChat');
		this.view?.show?.(true);
	}

	async runCodeAction(action: CodeAction) {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage('Open a code file first.');
			return;
		}

		const selected = editor.document.getText(editor.selection);
		if (action !== 'generate' && !selected.trim()) {
			vscode.window.showWarningMessage('Select some code first.');
			return;
		}

		let requirement = '';
		if (action === 'generate') {
			requirement = (await vscode.window.showInputBox({
				title: 'Generate Code',
				prompt: 'Describe the code you want to generate',
				ignoreFocusOut: true,
			}))?.trim() ?? '';
			if (!requirement) {
				return;
			}
		}

		const language = editor.document.languageId;
		const file = vscode.workspace.asRelativePath(editor.document.uri);
		const codeBlock = selected.trim() ? `\n\nSelected code from ${file}:\n\`\`\`${language}\n${selected}\n\`\`\`` : '';
		const prompts: Record<CodeAction, string> = {
			explain: `Explain this ${language} code clearly. Cover its purpose, important logic, and any risks.${codeBlock}`,
			fix: `Find and fix problems in this ${language} code. Explain the issue briefly, then return the complete replacement code in one fenced code block.${codeBlock}`,
			generate: `Generate ${language} code for this request: ${requirement}. Return ready-to-use code in a fenced code block.${codeBlock}`,
		};
		const labels: Record<CodeAction, string> = {
			explain: `Explain selected code in ${file}`,
			fix: `Fix selected code in ${file}`,
			generate: `Generate code: ${requirement}`,
		};
		const target = action === 'explain' ? undefined : {
			uri: editor.document.uri.toString(),
			range: new vscode.Range(editor.selection.start, editor.selection.end),
		};

		await this.reveal();
		if (!this.view) {
			this.pendingAction = { display: labels[action], prompt: prompts[action], target };
			return;
		}
		await this.send(labels[action], prompts[action], target);
	}

	private async handleMessage(message: { type?: string; text?: string; action?: CodeAction }) {
		switch (message.type) {
			case 'setApiKey':
				await setApiKey(this.context);
				return;
			case 'clear':
				this.messages.length = 0;
				this.applyTarget = undefined;
				this.lastReply = '';
				await this.post({ type: 'cleared' });
				return;
			case 'stop':
				this.abortController?.abort();
				return;
			case 'apply':
				await this.applyLastCode();
				return;
			case 'action':
				if (message.action) {
					await this.runCodeAction(message.action);
				}
				return;
			case 'send': {
				const text = message.text?.trim();
				if (text) {
					await this.send(text, this.attachSelection(text));
				}
			}
		}
	}

	private attachSelection(text: string): string {
		const editor = vscode.window.activeTextEditor;
		const selected = editor?.document.getText(editor.selection).trim();
		if (!editor || !selected) {
			return text;
		}
		return `${text}\n\nUse this selected ${editor.document.languageId} code as context:\n\`\`\`${editor.document.languageId}\n${selected}\n\`\`\``;
	}

	private async send(displayText: string, prompt: string, target?: SelectionTarget) {
		if (this.busy) {
			vscode.window.showInformationMessage('Wait for the current AI response or stop it first.');
			return;
		}

		let apiKey = await this.context.secrets.get(API_KEY_SECRET);
		if (!apiKey && await setApiKey(this.context)) {
			apiKey = await this.context.secrets.get(API_KEY_SECRET);
		}
		if (!apiKey) {
			await this.post({ type: 'error', message: 'An OpenAI API key is required.' });
			return;
		}

		this.messages.push({ role: 'user', content: prompt });
		this.busy = true;
		this.applyTarget = target;
		this.lastReply = '';
		this.abortController = new AbortController();
		await this.post({ type: 'user', text: displayText, hasSelection: prompt !== displayText });
		await this.post({ type: 'streamStart' });

		try {
			const config = vscode.workspace.getConfiguration('aiChat');
			const model = config.get<string>('model', DEFAULT_MODEL);
			const instructions = config.get<string>('systemPrompt',
				'You are a precise coding assistant inside Visual Studio Code. Prefer practical, safe, ready-to-use answers.');
			const stream = await new OpenAI({ apiKey }).responses.create({
				model,
				instructions,
				input: this.messages.map(({ role, content }) => ({ role, content })),
				stream: true,
			}, { signal: this.abortController.signal });

			for await (const event of stream) {
				if (event.type === 'response.output_text.delta') {
					this.lastReply += event.delta;
					await this.post({ type: 'delta', text: event.delta });
				}
			}
			if (!this.lastReply.trim()) {
				this.lastReply = 'The model returned an empty response.';
				await this.post({ type: 'delta', text: this.lastReply });
			}
			this.messages.push({ role: 'assistant', content: this.lastReply });
			await this.post({ type: 'streamEnd', canApply: Boolean(target && extractCode(this.lastReply)) });
		} catch (error) {
			if (this.lastReply.trim()) {
				this.messages.push({ role: 'assistant', content: this.lastReply });
			}
			if (error instanceof OpenAI.APIUserAbortError || (error as { name?: string }).name === 'AbortError') {
				await this.post({ type: 'streamEnd', stopped: true, canApply: false });
			} else {
				if (!this.lastReply) {
					this.messages.pop();
				}
				await this.post({ type: 'error', message: formatError(error) });
				await this.post({ type: 'streamEnd', canApply: false });
			}
		} finally {
			this.busy = false;
			this.abortController = undefined;
		}
	}

	private async applyLastCode() {
		const code = extractCode(this.lastReply);
		if (!code || !this.applyTarget) {
			vscode.window.showWarningMessage('There is no generated code to apply.');
			return;
		}
		const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(this.applyTarget.uri));
		const editor = await vscode.window.showTextDocument(document);
		const applied = await editor.edit((builder) => builder.replace(this.applyTarget!.range, code));
		if (applied) {
			vscode.window.showInformationMessage('AI-generated code applied. Review it before saving.');
		}
	}

	private post(message: object): Thenable<boolean> {
		return this.view?.webview.postMessage(message) ?? Promise.resolve(false);
	}
}

export function extractCode(text: string): string | undefined {
	const fenced = text.match(/```[^\n]*\n([\s\S]*?)```/);
	return fenced?.[1].replace(/\n$/, '');
}

export function formatError(error: unknown): string {
	if (error instanceof OpenAI.AuthenticationError) {
		return 'The OpenAI API key was rejected. Set a valid key and try again.';
	}
	if (error instanceof OpenAI.RateLimitError) {
		return 'OpenAI rate limit reached. Check your usage or try again shortly.';
	}
	if (error instanceof Error) {
		return `Request failed: ${error.message}`;
	}
	return 'The request failed for an unknown reason.';
}

export function buildWebviewHtml(webview: Pick<vscode.Webview, 'cspSource'>): string {
	const nonce = getNonce();
	return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font-family:var(--vscode-font-family)}main{height:100vh;display:grid;grid-template-rows:auto 1fr auto}.toolbar{display:flex;gap:6px;padding:8px;border-bottom:1px solid var(--vscode-sideBar-border,var(--vscode-panel-border));flex-wrap:wrap}button{border:0;border-radius:4px;padding:6px 9px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{color:var(--vscode-foreground);background:var(--vscode-button-secondaryBackground)}button:disabled,textarea:disabled{opacity:.55;cursor:not-allowed}#messages{overflow:auto;padding:10px}.empty{text-align:center;color:var(--vscode-descriptionForeground);margin-top:20vh}.message{margin-bottom:14px}.label{font-size:10px;font-weight:700;text-transform:uppercase;color:var(--vscode-descriptionForeground);margin:0 0 5px}.bubble{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45;padding:9px;border:1px solid var(--vscode-panel-border);border-radius:6px}.user .bubble{background:var(--vscode-textBlockQuote-background)}.context{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:4px}.apply{margin-top:7px}.cursor::after{content:'▋';animation:blink 1s infinite}@keyframes blink{50%{opacity:0}}form{padding:8px;border-top:1px solid var(--vscode-panel-border)}#error{display:none;color:var(--vscode-errorForeground);margin:0 0 7px}textarea{width:100%;min-height:72px;max-height:180px;resize:vertical;padding:8px;border:1px solid var(--vscode-input-border,transparent);border-radius:4px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);font:inherit}.composer-actions{display:flex;justify-content:space-between;align-items:center;margin-top:6px}.hint{font-size:10px;color:var(--vscode-descriptionForeground)}
</style></head><body><main>
<div class="toolbar"><button data-action="explain" class="secondary">Explain</button><button data-action="fix" class="secondary">Fix</button><button data-action="generate" class="secondary">Generate</button><button id="key" class="secondary" title="Set API key">Key</button><button id="clear" class="secondary" title="Clear chat">Clear</button></div>
<section id="messages" aria-live="polite"><div id="empty" class="empty"><h3>AI coding assistant</h3><p>Select code and choose an action,<br>or ask a question below.</p></div></section>
<form id="form"><div id="error" role="alert"></div><textarea id="input" placeholder="Ask about your code…" aria-label="Message"></textarea><div class="composer-actions"><span class="hint">Enter to send · Shift+Enter newline</span><div><button id="stop" type="button" class="secondary" hidden>Stop</button> <button id="send" type="submit">Send</button></div></div></form>
</main><script nonce="${nonce}">
const vscode=acquireVsCodeApi(),form=document.getElementById('form'),input=document.getElementById('input'),send=document.getElementById('send'),stop=document.getElementById('stop'),messages=document.getElementById('messages'),empty=document.getElementById('empty'),errorBox=document.getElementById('error');let streamBubble;
function message(role,text,context){empty.style.display='none';const item=document.createElement('article');item.className='message '+role;const label=document.createElement('div');label.className='label';label.textContent=role==='user'?'You':'Assistant';const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=text;item.append(label,bubble);if(context){const note=document.createElement('div');note.className='context';note.textContent='Selected code attached';item.append(note)}messages.append(item);messages.scrollTop=messages.scrollHeight;return {item,bubble}}
function busy(value){input.disabled=value;send.disabled=value;stop.hidden=!value;if(!value)input.focus()}
form.addEventListener('submit',e=>{e.preventDefault();const text=input.value.trim();if(!text||input.disabled)return;errorBox.style.display='none';vscode.postMessage({type:'send',text});input.value=''});input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();form.requestSubmit()}});stop.addEventListener('click',()=>vscode.postMessage({type:'stop'}));document.getElementById('key').addEventListener('click',()=>vscode.postMessage({type:'setApiKey'}));document.getElementById('clear').addEventListener('click',()=>vscode.postMessage({type:'clear'}));document.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>vscode.postMessage({type:'action',action:b.dataset.action})));
window.addEventListener('message',({data})=>{if(data.type==='user')message('user',data.text,data.hasSelection);if(data.type==='streamStart'){document.querySelectorAll('.apply').forEach(b=>b.disabled=true);busy(true);streamBubble=message('assistant','').bubble;streamBubble.classList.add('cursor')}if(data.type==='delta'&&streamBubble){streamBubble.textContent+=data.text;messages.scrollTop=messages.scrollHeight}if(data.type==='streamEnd'){busy(false);streamBubble?.classList.remove('cursor');if(data.stopped&&streamBubble)streamBubble.textContent+='\\n\\n[Stopped]';if(data.canApply&&streamBubble){const apply=document.createElement('button');apply.className='apply';apply.textContent='Apply code to editor';apply.addEventListener('click',()=>vscode.postMessage({type:'apply'}));streamBubble.parentElement.append(apply)}streamBubble=undefined}if(data.type==='error'){errorBox.textContent=data.message;errorBox.style.display='block'}if(data.type==='cleared'){messages.querySelectorAll('.message').forEach(n=>n.remove());empty.style.display='block';errorBox.style.display='none'}});input.focus();
</script></body></html>`;
}

function getNonce(): string {
	const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	return Array.from({ length: 32 }, () => characters[Math.floor(Math.random() * characters.length)]).join('');
}

export function deactivate() {}
