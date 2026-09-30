import { NextRequest, NextResponse } from "next/server";
import { transcribeAudio, synthesizeSpeech } from "@/lib/voice";
import { processVoiceIntent } from "@/lib/llm";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const audioFile = formData.get("audio") as Blob | null;
    const userId = formData.get("user_id") as string | null;
    const timezone = (formData.get("timezone") as string) || "Asia/Kolkata";

    if (!audioFile || !userId) {
      return NextResponse.json(
        { error: "Both 'audio' blob and 'user_id' fields are required" },
        { status: 400 }
      );
    }

    const arrayBuffer = await audioFile.arrayBuffer();
    const transcript = await transcribeAudio(Buffer.from(arrayBuffer), audioFile.type || "audio/webm");

    if (!transcript) {
      return NextResponse.json({
        spoken_response: "I didn't hear anything. Please try speaking again.",
        transcript: "",
        action: "reply",
      });
    }

    const intentResult = await processVoiceIntent(userId, transcript, timezone);

    let audioBase64 = "";
    if (intentResult.spoken_response) {
      const speechBuffer = await synthesizeSpeech(intentResult.spoken_response);
      audioBase64 = speechBuffer.toString("base64");
    }

    return NextResponse.json({
      user_transcript: transcript,
      spoken_response: intentResult.spoken_response,
      audio_base64: audioBase64,
      action: intentResult.action,
      status: intentResult.status,
      preview_id: intentResult.preview_id || null,
      data: intentResult.data || null,
    });
  } catch (error: any) {
    console.error("Voice processing pipeline error:", error);
    return NextResponse.json({ error: error.message || "Voice processing failed" }, { status: 500 });
  }
}