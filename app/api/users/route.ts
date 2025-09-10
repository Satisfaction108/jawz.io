import { type NextRequest, NextResponse } from "next/server"
import { promises as fs } from "fs"
import path from "path"
import type { User } from "@/lib/auth"

const USERS_DIR = path.join(process.cwd(), "users")
const USERS_FILE = path.join(USERS_DIR, "users.json")

// Ensure users directory exists
async function ensureUsersDir() {
  try {
    await fs.access(USERS_DIR)
  } catch {
    await fs.mkdir(USERS_DIR, { recursive: true })
  }
}

// Get users
async function getUsers(): Promise<User[]> {
  try {
    await ensureUsersDir()
    const data = await fs.readFile(USERS_FILE, "utf-8")
    return JSON.parse(data)
  } catch {
    return []
  }
}

// Save users
async function saveUsers(users: User[]): Promise<void> {
  await ensureUsersDir()
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2))
}

export async function GET() {
  try {
    const users = await getUsers()
    return NextResponse.json(users)
  } catch (error) {
    return NextResponse.json({ error: "Failed to get users" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const newUser: User = await request.json()
    const users = await getUsers()

    // Check if username already exists
    if (users.some((user) => user.username === newUser.username)) {
      return NextResponse.json({ error: "Username already exists" }, { status: 400 })
    }

    users.push(newUser)
    await saveUsers(users)

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: "Failed to save user" }, { status: 500 })
  }
}
