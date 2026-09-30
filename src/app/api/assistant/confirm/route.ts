import { NextRequest, NextResponse } from "next/server";
import { executeStagedAction } from "@/lib/google";
import { synthesizeSpeech } from "@/lib/voice";

export async function POST(req: NextRequest) {
  try {
    const { user_id, preview_id } = await req.json();

    if (!user_id || !preview_id) {
      return NextResponse.json({ error: "user_id and preview_id are required" }, { status: 400 });
    }

    const execution = await executeStagedAction(user_id, preview_id);

    let audioBase64 = "";
    if (execution.spoken) {
      const speech = await synthesizeSpeech(execution.spoken);
      audioBase64 = speech.toString("base64");
    }

    return NextResponse.json({
      status: "success",
      spoken_response: execution.spoken,
      audio_base64: audioBase64,
      result: execution,
    });
  } catch (error: any) {
    console.error("Action execution error:", error);
    return NextResponse.json({ error: error.message || "Failed to confirm action" }, { status: 500 });
  }
}