import { NextRequest, NextResponse } from "next/server";
import { syncGoogleContacts } from "@/lib/google";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";

    if (!userId) {
      return NextResponse.json({ error: "user_id is required" }, { status: 400 });
    }

    const result = await syncGoogleContacts(userId);
    return NextResponse.json({
      status: "synced",
      synced_contacts: result.syncedCount,
    });
  } catch (error: any) {
    console.error("Google contacts sync error:", error);
    return NextResponse.json(
      {
        error: "Google Contacts sync failed",
        detail: error?.response?.data?.error?.message || error?.message || "Unknown error",
        action: "Reconnect Google and grant Contacts access. Also confirm the People API is enabled in Google Cloud.",
      },
      { status: 502 }
    );
  }
}