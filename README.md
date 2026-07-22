# AI Chat for VS Code

An OpenAI coding assistant in the VS Code sidebar.

## Features

- Streaming AI chat

## Get an OpenAI API key

1. Open [OpenAI API Keys](https://platform.openai.com/api-keys).
2. Select **Create new secret key** and copy it.
3. In VS Code, run **AI: Set OpenAI API Key** and paste the key.

Keep your key private. Each user needs their own key, and API usage may incur charges.

## Use

1. Run **AI: Open Chat**.
2. Ask a question, or select code and choose **Explain**, **Fix**, or **Generate**.
3. Review generated code before applying it.

The key is stored with VS Code SecretStorage. Messages and selected code are sent to the OpenAI API.
