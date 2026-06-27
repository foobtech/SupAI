require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const pino = require('pino');

let userModels = {};
const conversationHistory = {}; // remoteJid -> array of {role, content} messages, for memory
const MAX_HISTORY_MESSAGES = 20; // keep the last N messages (user+assistant combined) per chat
const processedMessageIds = new Set(); // Tracks message IDs we've already replied to, to prevent duplicate responses

// Small helper: pause execution for a given number of milliseconds
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Calls Groq, and if it gets rate-limited (429), waits and retries.
// Gives up after maxRetries attempts so it can't loop forever.
// `history` is an array of {role, content} messages (excluding the system prompt) -
// this is what gives the bot memory of earlier messages in the same chat.
async function callGroqWithRetry(model, history, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: model,
                messages: [
                    { role: "system", content: "Your name is SupAI, a helpful multi-model AI assistant running natively on WhatsApp. Respond directly and concisely to what the user actually says. Don't introduce unrelated topics, puzzles, or examples unless the user specifically asks for one." },
                    ...history
                ]
            }, {
                headers: {
                    "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
                    "Content-Type": "application/json"
                }
            });
            return response; // success - hand it back to the caller
        } catch (error) {
            const status = error.response?.status;
            const isRateLimited = status === 429;

            // If it's NOT a rate limit error, or we're out of retries, give up and let
            // the caller's catch block handle it (sends the "hit an error" message).
            if (!isRateLimited || attempt === maxRetries) {
                throw error;
            }

            // Groq sends a retry-after header (in seconds) when rate-limited. Fall back to 5s if missing.
            const waitSeconds = Number(error.response?.headers?.['retry-after']) || 5;
            console.log(`Rate limited (attempt ${attempt}/${maxRetries}). Waiting ${waitSeconds}s before retrying...`);
            await sleep(waitSeconds * 1000);
            // loop continues to the next attempt
        }
    }
}

// Generates an image with Hugging Face's free Inference API, using FLUX.1-schnell
// (a fast, free-tier-friendly model). Returns a Buffer of the raw image bytes -
// ready to hand straight to Baileys.
// Free tier: no credit card needed. Rate-limited (a few hundred requests/hour, shared
// pool, not officially published) - if you hit limits often, this is where to look.
// Throws on failure - caller is responsible for catching and messaging the user.
async function generateImageHuggingFace(prompt) {
    const response = await axios.post(
        'https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell',
        {
            inputs: prompt
        },
        {
            headers: {
                "Authorization": `Bearer ${process.env.HF_TOKEN}`,
                "Content-Type": "application/json",
                "Accept": "image/png" // Without this, axios's default broad Accept header
                                       // gets rejected by HF's router with a 400 error.
            },
            responseType: 'arraybuffer' // the API returns raw image bytes, not JSON
        }
    );

    // A successful call returns the image directly as binary data.
    // If something went wrong, Hugging Face sends JSON instead (e.g. model loading,
    // rate limit, bad input) - axios still hands that to us as a buffer since we
    // forced arraybuffer, so we detect it by trying to parse it as JSON/text.
    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
        const errorJson = JSON.parse(Buffer.from(response.data).toString('utf-8'));
        throw new Error('Hugging Face returned an error instead of an image: ' + JSON.stringify(errorJson).slice(0, 300));
    }

    return Buffer.from(response.data);
}

async function startSupAI() {
    const { state, saveCreds } = await useMultiFileAuthState('supai_auth_session');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear();
            console.log("✨ Scan this QR code with WhatsApp to log in SupAI:\n");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                startSupAI();
            }
        } else if (connection === 'open') {
            console.clear();
            console.log('🚀 SupAI is officially online and connected to WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        // Safely extract the first message array element using optional chaining
        const msg = m.messages?.[0];
        if (!msg || !msg.message) return; // Cleanly exit if it's just background metadata!

        // Critical guard: ignore any message that THIS bot's own WhatsApp account sent.
        // Without this, the bot can end up replying to its own messages (e.g. if another
        // automated assistant like Meta AI replies to SupAI, SupAI would treat that as a new
        // prompt and reply again, forever - an infinite bot-to-bot loop).
        if (msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;

        // De-dupe guard: WhatsApp/baileys can sometimes emit the same message more than once
        // (e.g. on reconnect). If we've already replied to this exact message, skip it.
        const messageId = msg.key.id;
        if (messageId) {
            if (processedMessageIds.has(messageId)) {
                return; // already handled this one - don't reply again
            }
            processedMessageIds.add(messageId);

            // Prevent the Set from growing forever during a long-running session.
            // Once it gets large, clear out the oldest half.
            if (processedMessageIds.size > 1000) {
                const idsToRemove = Array.from(processedMessageIds).slice(0, 500);
                idsToRemove.forEach(id => processedMessageIds.delete(id));
            }
        }

        const text = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            ""
        ).trim();

        if (!text) return;

        // 1. Model Switching Commands
        // NOTE: Groq deprecated llama-3.3-70b-versatile and llama-3.1-8b-instant in June 2026.
        // Using their recommended, currently-active replacements below. If Groq deprecates a model
        // again, they email a specific replacement name - check console.groq.com/docs/deprecations.
        if (text.startsWith('/llama')) {
            userModels[remoteJid] = "meta-llama/llama-4-scout-17b-16e-instruct";
            await sock.sendMessage(remoteJid, { text: "✨ *SupAI Status*: Switched to Llama 4 Scout (Free Mode)!" });
            return;
        }
        if (text === '/qwen' || text.startsWith('/qwen ')) {
            userModels[remoteJid] = "qwen/qwen3.6-27b";
            await sock.sendMessage(remoteJid, { text: "✨ *SupAI Status*: Switched to Qwen (Free Mode)!" });
            return;
        }
        if (text.startsWith('/gptoss')) {
            userModels[remoteJid] = "openai/gpt-oss-120b";
            await sock.sendMessage(remoteJid, { text: "✨ *SupAI Status*: Switched to GPT-OSS 120B (Free Mode)!" });
            return;
        }
        if (text === '/reset') {
            delete conversationHistory[remoteJid];
            await sock.sendMessage(remoteJid, { text: "🧹 *SupAI Status*: Conversation memory cleared! Starting fresh." });
            return;
        }

        // 2. Image Generation Command
        if (text.startsWith('/image')) {
            const prompt = text.slice('/image'.length).trim();
            if (!prompt) {
                await sock.sendMessage(remoteJid, { text: "🎨 Usage: `/image a cat in space wearing a helmet`" });
                return;
            }
            try {
                await sock.sendPresenceUpdate('composing', remoteJid);
                const imageBuffer = await generateImageHuggingFace(prompt);
                await sock.sendMessage(remoteJid, { image: imageBuffer });
            } catch (error) {
                const status = error.response?.status;
                // error.response.data is a Buffer (since we requested arraybuffer) - convert
                // it to text so we can actually see HF's error message, not just the status code.
                let errorDetail = error.message;
                if (error.response?.data) {
                    try {
                        errorDetail = Buffer.from(error.response.data).toString('utf-8');
                    } catch (_) { /* fall back to error.message if this fails */ }
                }
                console.error("Hugging Face Image API Error:", status, errorDetail);
                if (status === 503) {
                    // Free-tier models "sleep" when idle and need a cold-start, which HF
                    // reports as 503 rather than a normal error. A retry shortly after works.
                    await sock.sendMessage(remoteJid, { text: "🥱 The image model is waking up (it sleeps when idle on the free tier). Try again in about 20 seconds." });
                } else if (status === 429) {
                    await sock.sendMessage(remoteJid, { text: "⏳ SupAI is generating images too fast right now (free tier limit). Wait a bit and try again." });
                } else {
                    await sock.sendMessage(remoteJid, { text: "⚠️ Sorry, SupAI hit an error generating that image. Try again in a moment." });
                }
            }
            return;
        }

        if (text === '/help' || text === '/menu') {
            const menuText = `👋 *Welcome to SupAI!*\n\nSwitch your AI brain instantly using these commands:\n\n👉 \`/llama\` - Switch to Llama 4 Scout\n👉 \`/qwen\` - Switch to Qwen\n👉 \`/gptoss\` - Switch to GPT-OSS 120B\n👉 \`/reset\` - Clear conversation memory\n\n🎨 *Image Generation:*\n👉 \`/image <prompt>\` - Generate an image (e.g. \`/image a cat in space\`)\n\nJust send a normal message to start chatting!`;
            await sock.sendMessage(remoteJid, { text: menuText });
            return;
        }

        const currentModel = userModels[remoteJid] || "meta-llama/llama-4-scout-17b-16e-instruct";

        // Grab this chat's history so far (or start a fresh one), then add the new user message.
        const history = conversationHistory[remoteJid] || [];
        history.push({ role: "user", content: text });

        try {
            await sock.sendPresenceUpdate('composing', remoteJid);

            const response = await callGroqWithRetry(currentModel, history);

            const choice = response.data?.choices?.[0];
            let aiReply = choice?.message?.content;

            // Safety net: if the response was empty/malformed (no usable content), fail clearly
            // instead of sending "null" or other garbage to the user.
            if (!aiReply || typeof aiReply !== 'string' || !aiReply.trim()) {
                throw new Error('Empty or malformed response from model: ' + JSON.stringify(response.data).slice(0, 300));
            }

            // Some models (e.g. Qwen) are "reasoning models" that include their internal
            // step-by-step thinking inside <think>...</think> tags within the content field.
            // Strip that out so only the actual answer gets sent to WhatsApp.
            aiReply = aiReply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

            // If stripping <think> tags left nothing behind (model only "thought" and never
            // gave a final answer), fail clearly rather than sending an empty message.
            if (!aiReply) {
                throw new Error('Response was only reasoning text with no final answer.');
            }

            // Success - save the AI's reply into history too, so future messages have full context.
            history.push({ role: "assistant", content: aiReply });

            // Keep history from growing forever (and from eating into Groq's token-per-minute limit).
            // Trim from the front, keeping the most recent messages.
            if (history.length > MAX_HISTORY_MESSAGES) {
                history.splice(0, history.length - MAX_HISTORY_MESSAGES);
            }
            conversationHistory[remoteJid] = history;

            await sock.sendMessage(remoteJid, { text: aiReply });

        } catch (error) {
            console.error("Groq API Communication Error:", error.response?.data || error.message);
            await sock.sendMessage(remoteJid, { text: "⚠️ Sorry, SupAI hit an error talking to the AI. Try again in a moment." });
            // Note: we don't save this failed exchange into history, so a failed attempt
            // doesn't pollute future context with an error that was never actually answered.
        }
    });
}

startSupAI();
