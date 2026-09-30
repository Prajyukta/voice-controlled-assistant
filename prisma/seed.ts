import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const friends = [
  { name: "Rishi", alias: "rishi, rishikesh", email: "rishikeshbrahma78@gmail.com", role: "Friend" },
  { name: "Manoj", alias: "manoj, manos", email: "iammanojkumarrath@gmail.com", role: "Friend" },
  { name: "Jigyansha", alias: "jigyansha, jigyansa", email: "jigyanshaparida27@gmail.com", role: "Friend" },
  { name: "Raj", alias: "raj, rajkumar", email: "rajkumarmalik66193@gmail.com", role: "Friend" },
];

async function seed() {
  const userId = "usr_primary";

  await prisma.contact.deleteMany({
    where: { userId, email: "manoj@example.com" },
  });

  for (const friend of friends) {
    await prisma.contact.upsert({
      where: { userId_email: { userId, email: friend.email } },
      update: { name: friend.name, alias: friend.alias, role: friend.role },
      create: { userId, ...friend },
    });
  }

  console.log("Successfully added Rishi, Manoj, Jigyansha, and Raj to the database.");
}

seed()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });