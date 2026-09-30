import { NextRequest, NextResponse } from "next/server";
import { getOAuth2Client, GOOGLE_SCOPES } from "@/lib/google";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("user_id");

  if (!userId) {
    return NextResponse.json({ error: "Query parameter user_id is required" }, { status: 400 });
  }

  const oauth2Client = getOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state: userId,
  });

  return NextResponse.redirect(url);
}