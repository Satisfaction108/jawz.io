import { type NextRequest, NextResponse } from "next/server"
import { promises as fs } from "fs"
import path from "path"
import type { User } from "@/lib/auth"

const USERS_DIR = path.join(process.cwd(), "users")
const USERS_FILE = path.join(USERS_DIR, "users.json")

// Get users
async function getUsers(): Promise<User[]> {
  try {
    const data = await fs.readFile(USERS_FILE, "utf-8")
    return JSON.parse(data)
  } catch {
    return []
  }
}

// Save users
async function saveUsers(users: User[]): Promise<void> {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2))
}

export async function PATCH(request: NextRequest, { params }: { params: { username: string } }) {
  try {
    const { password } = await request.json()
    const username = params.username

    const users = await getUsers()
    const userIndex = users.findIndex((user) => user.username === username)

    if (userIndex === -1) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    // Update password
    users[userIndex].password = password
    await saveUsers(users)

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: "Failed to update password" }, { status: 500 })
  }
}
