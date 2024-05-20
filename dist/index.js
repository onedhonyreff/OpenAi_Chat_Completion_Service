import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import bodyParser from "body-parser";
import axios from "axios";
import https from "https";
import os from "os";
import { encode } from "gpt-3-encoder";
import { randomUUID, randomInt, createHash } from "crypto";
import { config } from "dotenv";
config();
const port = process.env.PORT ?? 8000;
const baseUrl = "https://chat.openai.com";
const apiUrl = `${baseUrl}/backend-anon/conversation`;
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
let cloudflared;
const axiosInstance = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    headers: {
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "oai-language": "en-US",
        origin: baseUrl,
        pragma: "no-cache",
        referer: baseUrl,
        "sec-ch-ua": '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent": userAgent,
    },
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function GenerateCompletionId(prefix = "cmpl-") {
    const characters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const length = 28;
    for (let i = 0; i < length; i++) {
        prefix += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return prefix;
}
async function* chunksToLines(chunksAsync) {
    let previous = "";
    for await (const chunk of chunksAsync) {
        const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        previous += bufferChunk;
        let eolIndex;
        while ((eolIndex = previous.indexOf("\n")) >= 0) {
            const line = previous.slice(0, eolIndex + 1).trimEnd();
            if (line === "data: [DONE]")
                break;
            if (line.startsWith("data: "))
                yield line;
            previous = previous.slice(eolIndex + 1);
        }
    }
}
async function* linesToMessages(linesAsync) {
    for await (const line of linesAsync) {
        const message = line.substring("data :".length);
        yield message;
    }
}
async function* StreamCompletion(data) {
    yield* linesToMessages(chunksToLines(data));
}
function GenerateProofToken(seed, diff, userAgent) {
    const cores = [8, 12, 16, 24];
    const screens = [3000, 4000, 6000];
    const core = cores[randomInt(0, cores.length)];
    const screen = screens[randomInt(0, screens.length)];
    const now = new Date(Date.now() - 8 * 3600 * 1000);
    const parseTime = now
        .toUTCString()
        .replace("GMT", "GMT-0500 (Eastern Time)");
    const config = [core + screen, parseTime, 4294705152, 0, userAgent];
    const diffLen = diff.length / 2;
    for (let i = 0; i < 100000; i++) {
        config[3] = i;
        const jsonData = JSON.stringify(config);
        const base = Buffer.from(jsonData).toString("base64");
        const hashValue = createHash("sha3-512")
            .update(seed + base)
            .digest();
        if (hashValue.toString("hex").substring(0, diffLen) <= diff) {
            const result = "gAAAAAB" + base;
            return result;
        }
    }
    const fallbackBase = Buffer.from(`"${seed}"`).toString("base64");
    return "gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + fallbackBase;
}
function enableCORS(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }
    next();
}
function handleErrorResponse(error) {
    if (axios.isAxiosError(error) && error.response) {
        const statusCode = error.response.status;
        const responseBody = error.response.data;
        console.error(`Error: Status Code ${statusCode}`, responseBody);
        return {
            status: false,
            statusCode: statusCode,
            error: responseBody.message,
        };
    }
    else {
        return {
            status: false,
            statusCode: 500,
            error: "Internal server error",
        };
    }
}
function handleDefault(req, res) {
    res.write("Welcome OpenAI Chat Completion API - The service running correctly");
    return res.end();
}
async function handleChatCompletion(req, res) {
    const completionRequest = req.body;
    const session = completionRequest.session;
    const conversation = completionRequest.conversation;
    console.log(`Incoming request: ${session.deviceId} - ${conversation.messages[conversation.messages.length - 1].content}`);
    if (!session) {
        res.status(400).json({
            status: false,
            statusCode: 400,
            error: "Bad request - invalid session",
        });
        return;
    }
    try {
        let proofToken = GenerateProofToken(session.proofofwork.seed, session.proofofwork.difficulty, userAgent);
        const body = {
            action: "next",
            messages: conversation.messages.map((message) => ({
                author: { role: message.role },
                content: { content_type: "text", parts: [message.content] },
            })),
            parent_message_id: randomUUID(),
            model: conversation.model ?? "text-davinci-002-render-sha",
            timezone_offset_min: -180,
            suggestions: [],
            history_and_training_disabled: true,
            conversation_mode: { kind: "primary_assistant" },
            websocket_request_id: randomUUID(),
        };
        let promptTokens = 0;
        let completionTokens = 0;
        for (let message of conversation.messages) {
            promptTokens += encode(message.content).length;
        }
        const response = await axiosInstance.post(apiUrl, body, {
            responseType: "stream",
            headers: {
                "oai-device-id": session.deviceId,
                "openai-sentinel-chat-requirements-token": session.token,
                "openai-sentinel-proof-token": proofToken,
            },
        });
        res.setHeader("Content-Type", "application/json");
        let fullContent = "";
        let requestId = GenerateCompletionId("chatcmpl-");
        let created = Math.floor(Date.now() / 1000);
        let finish_reason = null;
        let error;
        for await (const message of StreamCompletion(response.data)) {
            if (message.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}.\d{6}$/))
                continue;
            const parsed = JSON.parse(message);
            if (parsed.error) {
                error = `Error message from OpenAI: ${parsed.error}`;
                finish_reason = "stop";
                break;
            }
            let content = parsed?.message?.content?.parts[0] ?? "";
            let status = parsed?.message?.status ?? "";
            for (let message of conversation.messages) {
                if (message.content === content) {
                    content = "";
                    break;
                }
            }
            switch (status) {
                case "in_progress":
                    finish_reason = null;
                    break;
                case "finished_successfully":
                    let finish_reason_data = parsed?.message?.metadata?.finish_details?.type ?? null;
                    switch (finish_reason_data) {
                        case "max_tokens":
                            finish_reason = "length";
                            break;
                        case "stop":
                        default:
                            finish_reason = "stop";
                    }
                    break;
                default:
                    finish_reason = null;
            }
            if (content === "")
                continue;
            let completionChunk = content.replace(fullContent, "");
            completionTokens += encode(completionChunk).length;
            fullContent =
                content.length > fullContent.length ? content : fullContent;
        }
        const completionResult = {
            id: requestId,
            created: created,
            model: "gpt-3.5-turbo",
            object: "chat.completion",
            choices: [
                {
                    finishReason: finish_reason,
                    index: 0,
                    message: {
                        content: error ?? fullContent,
                        role: "assistant",
                    },
                },
            ],
            usage: {
                promptTokens: promptTokens,
                completionTokens: completionTokens,
                totalTokens: promptTokens + completionTokens,
            },
        };
        res.status(200).json(completionResult);
    }
    catch (error) {
        const errorResponse = handleErrorResponse(error);
        if (!errorResponse.error) {
            errorResponse.error = "Error while getting completions...";
        }
        res.setHeader("Content-Type", "application/json");
        res.status(errorResponse.statusCode).json(errorResponse);
    }
}
const app = express();
app.use(bodyParser.json());
app.use(enableCORS);
app.get("/", handleDefault);
app.post("/v1/chat-completion", handleChatCompletion);
app.use((req, res) => res.status(404).send({
    status: false,
    error: {
        message: `The requested endpoint (${req.method.toLocaleUpperCase()} ${req.path}) was not found. please make sure to use "http://localhost:${port}/v1" as the base URL.`,
        type: "invalid_request_error",
    },
}));
async function DownloadCloudflared() {
    const platform = os.platform();
    let url;
    if (platform === "win32") {
        const arch = os.arch() === "x64" ? "amd64" : "386";
        url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`;
    }
    else {
        let arch = os.arch();
        switch (arch) {
            case "x64":
                arch = "amd64";
                break;
            case "arm":
            case "arm64":
                break;
            default:
                arch = "amd64";
        }
        const platformLower = platform.toLowerCase();
        url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${platformLower}-${arch}`;
    }
    const fileName = platform === "win32" ? "cloudflared.exe" : "cloudflared";
    const filePath = path.resolve(fileName);
    if (fs.existsSync(filePath)) {
        return filePath;
    }
    try {
        const response = await axiosInstance({
            method: "get",
            url: url,
            responseType: "stream",
        });
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on("finish", () => {
                if (platform !== "win32") {
                    fs.chmodSync(filePath, 0o755);
                }
                resolve(filePath);
            });
            writer.on("error", reject);
        });
    }
    catch (error) {
        return null;
    }
}
async function StartCloudflaredTunnel(cloudflaredPath) {
    if (!cloudflaredPath) {
        console.error("Failed to download Cloudflared executable.");
        return null;
    }
    const localUrl = `http://localhost:${port}`;
    return new Promise((resolve, reject) => {
        cloudflared = spawn(cloudflaredPath, ["tunnel", "--url", localUrl]);
        cloudflared.stdout.on("data", (data) => {
            const output = data.toString();
            const urlMatch = output.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
            if (urlMatch) {
                let url = urlMatch[0];
                resolve(url);
            }
        });
        cloudflared.stderr.on("data", (data) => {
            const output = data.toString();
            const urlMatch = output.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
            if (urlMatch) {
                let url = urlMatch[0];
                resolve(url);
            }
        });
        cloudflared.on("close", (code) => {
            resolve(null);
        });
    });
}
app.listen(Number(port), "0.0.0.0", async () => {
    let filePath;
    let publicURL;
    if (process.env.CLOUDFLARED ?? true) {
        filePath = await DownloadCloudflared();
        publicURL = await StartCloudflaredTunnel(filePath);
    }
    console.log(`💡 Server is running at http://localhost:${port}`);
    console.log();
    console.log(`🔗 Local Base URL: http://localhost:${port}/v1`);
    console.log(`🔗 Local Endpoint: http://localhost:${port}/v1/chat/completions`);
    console.log();
    if (cloudflared && publicURL)
        console.log(`🔗 Public Base URL: ${publicURL}/v1`);
    if (cloudflared && publicURL)
        console.log(`🔗 Public Endpoint: ${publicURL}/v1/chat/completions`);
    else if (cloudflared && !publicURL) {
        console.log("🔗 Public Endpoint: (Failed to start cloudflared tunnel, please restart the server.)");
        if (filePath)
            fs.unlinkSync(filePath);
    }
});
//# sourceMappingURL=index.js.map