# AI Chat for VS Code

An OpenAI-powered coding assistant in the VS Code sidebar. Ask questions, stream answers, explain or fix selected code, and generate code without leaving the editor.

## Features

- Native Activity Bar and sidebar chat view
- Streaming OpenAI Responses API output
- Automatically attaches selected editor code to normal chat messages
- **Explain Selected Code**, **Fix Selected Code**, and **Generate Code** commands
- Editor context-menu actions for selected code
- Review-first **Apply code to editor** button for generated fixes
- Secure API-key storage through VS Code SecretStorage
- Configurable model and system prompt

## Getting started

1. Open the AI Chat icon in the Activity Bar, or run **AI: Open Chat**.
2. Select **Key** and enter an OpenAI API key.
3. Ask a question, or select code and use **Explain**, **Fix**, or **Generate**.
4. Review generated code before choosing **Apply code to editor** and saving the file.
