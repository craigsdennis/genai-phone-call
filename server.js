require("dotenv").config();
const CONFIG = require("./config.json");

// Set up express
const express = require("express");
const ExpressWs = require("express-ws");
const app = express();
ExpressWs(app);

// Set up Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = require('twilio')(accountSid, authToken);

// Set up OpenAI
const { OpenAI } = require("openai");
const openai = new OpenAI({
  apiKey: process.env["OPENAI_API_KEY"],
});

// Set up our services
const { TextToSpeechService } = require("./tts-service");
const { TranscriptionService } = require("./transcription-service");

// Set route for initializing the call. This is the route that Twilio will hit.
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

// Set up the websocket route for the media stream
app.ws("/connection", (ws, req) => {
  // Log errors
  ws.on("error", console.error);

  // Filled in from start message
  let streamSid;
  let callSid;

  // Initialize variables
  let hangup = false;
  let userChatCount = 0;
  const messages = [
    {
      role: "system",
      content:CONFIG.system_prompt
    },
    { role: "user", content: CONFIG.greetings_prompt },
  ];

  // Set up services
  const transcriptionService = new TranscriptionService();
  const ttsService = new TextToSpeechService({});

  // Incoming from MediaStream
  ws.on("message", async function message(data) {
    const msg = JSON.parse(data);
    
    // If its the start of the stream...
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid;
      console.log(`Starting Media Stream for ${streamSid} on call ${callSid}`);
      // Generate, store, and say a greetings message
      const chatCompletion = await chat(messages);
      messages.push(chatCompletion);
      ttsService.generate(chatCompletion.content);
    
    // If its a media event, meaning audio has been sent...
    } else if (msg.event === "media") {
      // Send the audio to be played on the stream
      transcriptionService.send(msg.media.payload);
    
    // If its a mark event, meaning the audio has ended...
    } else if (msg.event === "mark") {
      const label = msg.mark.name;
      console.log(`Media completed mark (${msg.sequenceNumber}): ${label}`);
      // If the hangup flag is set, end call after saying message
      if (hangup){
        twilioClient.calls(callSid)
          .update({status: 'completed'})
          .then(call => console.log(call.to));
      }
      // Generate goodby and set call to end after convo limit reached
      else if (userChatCount >= CONFIG.user_chat_count){
        console.log("Add goodbye prompt");
        // The next time "mark" is sent end the call 
        hangup = true;
        // Add goodbye prompt to the stack, generate response, and say it
        messages.push({role: "user", content: CONFIG.goodbye_prompt});
        const chatCompletion = await chat(messages);
        ttsService.generate(chatCompletion.content);
      }
    }
  });

  // When the transcription service receives a transcription of the audio
  transcriptionService.on("transcription", async (text) => {
    console.log(`Received transcription: ${text}`);
    // Add user message to the message stack & increment counter
    messages.push({ role: "user", content: text });
    userChatCount++;
    // Generate response, add to message stack, and say it
    const chatCompletion = await chat(messages);
    messages.push(chatCompletion);
    ttsService.generate(chatCompletion.content);   
  });

  // When the tts service has generated audio
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

// OpenAI chat function
async function chat(messages) {
  const chatCompletion = await openai.chat.completions.create({
    messages: messages,
    model: "gpt-3.5-turbo",
  });
  return chatCompletion.choices[0].message;
}

// Start the server
app.listen(CONFIG.port || 3000);
console.log(`Server running on port ${CONFIG.port || 3000}`);
