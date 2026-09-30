import { createClient } from "@deepgram/sdk";

const deepgram = createClient(process.env.DEEPGRAM_API_KEY || "");

export async function transcribeAudio(audioBuffer: Buffer, mimeType = "audio/webm"): Promise<string> {
  const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
    audioBuffer,
    {
      model: "nova-2",
      smart_format: true,
      mimetype: mimeType,
    }
  );

  if (error || !result) {
    throw new Error(`Deepgram transcription failed: ${error?.message || "Unknown error"}`);
  }

  return (result.results.channels[0]?.alternatives[0]?.transcript || "").trim();
}

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const response = await deepgram.speak.request(
    { text },
    {
      model: "aura-asteria-en",
      encoding: "linear16",
      container: "wav",
    }
  );

  const stream = await response.getStream();
  if (!stream) {
    throw new Error("Deepgram TTS returned an empty audio stream.");
  }

  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  return Buffer.concat(chunks);
}