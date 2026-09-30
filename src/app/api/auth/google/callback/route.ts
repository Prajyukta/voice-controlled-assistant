import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { getOAuth2Client, GOOGLE_SCOPES, syncGoogleContacts } from "@/lib/google";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");
    const userId = searchParams.get("state");

    if (!code || !userId) {
      return NextResponse.json({ error: "Missing code or state in callback" }, { status: 400 });
    }

    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email || "";

    await prisma.userGoogleToken.upsert({
      where: { userId },
      update: {
        accessToken: tokens.access_token!,
        ...(tokens.refresh_token && { refreshToken: tokens.refresh_token }),
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
        email,
      },
      create: {
        userId,
        email,
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token || "",
        scopes: GOOGLE_SCOPES.join(","),
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
      },
    });

    let syncedCount = 0;
    let contactsError: string | null = null;
    try {
      const result = await syncGoogleContacts(userId);
      syncedCount = result.syncedCount;
    } catch (contactError: any) {
      contactsError = contactError?.message || "Google Contacts sync failed";
      console.error("Google contacts sync failed during callback:", contactError);
    }

    return NextResponse.json({
      status: "authenticated",
      user_id: userId,
      email,
      synced_contacts: syncedCount,
      contacts_error: contactsError,
      message: contactsError
        ? "Google account linked, but Contacts could not be synced. Reauthorize Google and confirm Contacts access is enabled."
        : "Google Calendar, Gmail, and Contacts successfully linked.",
    });
  } catch (error: any) {
    console.error("Google callback error:", error);
    return NextResponse.json(
      {
        error: "Google authentication failed",
        detail: error?.message || "Unknown OAuth error",
      },
      { status: 400 }
    );
  }
}