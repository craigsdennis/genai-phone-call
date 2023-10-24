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

  const messages = [
    {
      role: "system",
      content:
        "You are a monster that lives in Denver, Colorado. Your current body looks like a white and gray house. You have two eyes, large teeth, and a red tongue. You are scary but in a silly way. Your response should pithy and no more than 16 words.",
    },
    { role: "user", content: "Come up with a pithy greeting" },
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
      if (messages.length >= 12){
        console.log("Add goodbye prompt");
        hangup = true;
        messages.push({role: "user", content: "Come up with a pithy goodby message. Assume you may be cutting the user off. You can be a little rude"});
        const chatCompletion = await chat(messages);
        messages.push(chatCompletion);
        ttsService.generate(chatCompletion.content);
      }
    }
  });

  transcriptionService.on("transcription", async (text) => {
    console.log(`Received transcription: ${text}`);
    messages.push({ role: "user", content: text });
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
