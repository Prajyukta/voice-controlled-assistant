import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendEmailDirect } from "@/lib/google";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");

  if (!cronSecret || authorization !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dueEmails = await prisma.scheduledEmail.findMany({
    where: { sendAt: { lte: new Date() }, sentAt: null },
    orderBy: { sendAt: "asc" },
    take: 100,
  });

  let sent = 0;
  const failures: string[] = [];

  for (const email of dueEmails) {
    try {
      await sendEmailDirect(email.userId, email.toEmail, email.subject, email.body);
      await prisma.scheduledEmail.update({
        where: { id: email.id },
        data: { sentAt: new Date() },
      });
      sent += 1;
    } catch (error) {
      console.error(`Scheduled email ${email.id} failed`, error);
      failures.push(email.id);
    }
  }

  return NextResponse.json({ processed: dueEmails.length, sent, failed: failures });
}
