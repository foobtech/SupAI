# SupAI

A multi-model AI chatbot that runs natively inside WhatsApp, powered by [Baileys](https://github.com/WhiskeySockets/Baileys) and [Groq](https://groq.com).

## Features

- Chat with AI directly through WhatsApp - no separate app needed
- Switch between multiple free AI models on the fly:
  - `/llama` - Llama 4 Scout
  - `/qwen` - Qwen
  - `/gptoss` - GPT-OSS 120B
- Remembers conversation context (per chat)
- `/reset` to clear memory and start fresh
- `/menu` or `/help` to see all commands
- Automatic retry with backoff if a model is temporarily rate-limited

## Setup

1. **Clone this repo and install dependencies:**
   ```bash
   git clone <your-repo-url>
   cd supai-bot
   npm install
   ```

2. **Get a free Groq API key:**
   - Sign up at [console.groq.com](https://console.groq.com) (no credit card required)
   - Go to API Keys → Create API Key
   - Copy the key

3. **Create a `.env` file** in the project root with:
   ```
   GROQ_API_KEY=your_groq_key_here
   ```

4. **Run it:**
   ```bash
   node index.js
   ```

5. **Scan the QR code** that appears in your terminal using WhatsApp on your phone (Settings → Linked Devices → Link a Device).

Once connected, message the WhatsApp number you linked and start chatting!

## Notes

- This uses Groq's free tier, which has rate limits (requests per minute/day). If you hit a rate limit, the bot will automatically wait and retry.
- Free model availability on Groq can change over time. If you see a "model decommissioned" error, check [console.groq.com/docs/deprecations](https://console.groq.com/docs/deprecations) for the current model names and update the slugs in `index.js`.
- Your WhatsApp login session is stored locally in `supai_auth_session/` - this is gitignored and should never be committed or shared, since it grants access to your linked WhatsApp account.

## Disclaimer

This is a personal project for learning/fun. Don't share your `.env` file, API keys, or `supai_auth_session/` folder with anyone.
