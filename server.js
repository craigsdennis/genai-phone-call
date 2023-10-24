require("dotenv").config();
const express = require("express");
const ExpressWs = require("express-ws");

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = require('twilio')(accountSid, authToken);

const { TextToSpeechService } = require("./tts-service");
const { TranscriptionService } = require("./transcription-service");

const { OpenAI } = require("openai");

const openai = new OpenAI({
  apiKey: process.env["OPENAI_API_KEY"],
});

const CONFIG = require("./config.json");

const app = express();
ExpressWs(app);

const PORT = 3000;

app.post("/incoming", (req, res) => {
  res.status(200);
  res.type("text/xml");
  res.end(`
  <Response>
    <Connect>
      <Stream url="wss://${process.env.SERVER}/connection" />
    </Connect>
  </Response>
  `);
});

app.ws("/connection", (ws, req) => {
  ws.on("error", console.error);
  // Filled in from start message
  let streamSid;
  let callSid;
  let hangup = false;
  let userChatCount = 0;

  const messages = [
    {
      role: "system",
      content:CONFIG.system_prompt
    },
    { role: "user", content: CONFIG.greetings_prompt },
  ];

  const transcriptionService = new TranscriptionService();
  const ttsService = new TextToSpeechService({});

  // Incoming from MediaStream
  ws.on("message", async function message(data) {
    const msg = JSON.parse(data);
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid;
      console.log(`Starting Media Stream for ${streamSid} on call ${callSid}`);
      const chatCompletion = await chat(messages);
      messages.push(chatCompletion);
      ttsService.generate(chatCompletion.content);
    } else if (msg.event === "media") {
      transcriptionService.send(msg.media.payload);
    } else if (msg.event === "mark") {
      const label = msg.mark.name;
      console.log(`Media completed mark (${msg.sequenceNumber}): ${label}`);
      // If the hangup flag is set, end call after saying message
      if (hangup){
        twilioClient.calls(callSid)
          .update({status: 'completed'})
          .then(call => console.log(call.to));
      }
      // Generate goodby and set call to end after it has gone on long enough
      if (userChatCount >= CONFIG.user_chat_count){
        console.log("Add goodbye prompt");
        hangup = true;
        messages.push({role: "user", content: CONFIG.goodbye_prompt});
        const chatCompletion = await chat(messages);
        messages.push(chatCompletion);
        ttsService.generate(chatCompletion.content);
      }
    }
  });

  transcriptionService.on("transcription", async (text) => {
    console.log(`Received transcription: ${text}`);
    messages.push({ role: "user", content: text });
    userChatCount++;
    const chatCompletion = await chat(messages);
    messages.push(chatCompletion);
    ttsService.generate(chatCompletion.content);
    console.log(`Messages Length: ${messages.length}`);
    
  });

  ttsService.on("speech", (audio, label) => {
    console.log(`Sending audio to Twilio ${audio.length} b64 characters`);
    ws.send(
      JSON.stringify({
        streamSid,
        event: "media",
        media: {
          payload: audio,
        },
      })
    );
    // When the media completes you will receive a `mark` message with the label
    ws.send(
      JSON.stringify({
        streamSid,
        event: "mark",
        mark: {
          name: label,
        },
      })
    );
  });
});

async function chat(messages) {
  const chatCompletion = await openai.chat.completions.create({
    messages: messages,
    model: "gpt-3.5-turbo",
  });
  console.log(chatCompletion.choices[0]);
  return chatCompletion.choices[0].message;
}

app.listen(PORT);
console.log(`Server running on port ${PORT}`);
