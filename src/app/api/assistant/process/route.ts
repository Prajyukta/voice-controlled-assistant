import { NextRequest, NextResponse } from "next/server";
import { processVoiceIntent } from "@/lib/llm";

export async function POST(req: NextRequest) {
  try {
    const { user_id, message, timezone } = await req.json();

    if (!user_id || !message) {
      return NextResponse.json({ error: "user_id and message are required" }, { status: 400 });
    }

    const result = await processVoiceIntent(user_id, message, timezone || "Asia/Kolkata");
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Text process error:", error);
    return NextResponse.json({ error: error.message || "Failed to process message" }, { status: 500 });
  }
}