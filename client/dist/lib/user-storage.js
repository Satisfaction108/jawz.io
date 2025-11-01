// Get all users from storage
export async function getUsers() {
    try {
        const response = await fetch("/api/users");
        if (!response.ok)
            return [];
        return await response.json();
    }
    catch {
        return [];
    }
}
// Save user to storage
export async function saveUser(user) {
    try {
        const response = await fetch("/api/users", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(user),
        });
        return response.ok;
    }
    catch {
        return false;
    }
}
// Find user by username
export async function findUser(username) {
    const users = await getUsers();
    return users.find((user) => user.username === username) || null;
}
// Authenticate user
export async function authenticateUser(username, password) {
    const user = await findUser(username);
    if (!user)
        return null;
    // Import verification function
    const { verifyPassword } = await import("./auth");
    if (!verifyPassword(password, user.password))
        return null;
    return {
        username: user.username,
        timeCreated: user.timeCreated,
    };
}
export async function updateUserPassword(username, newPassword) {
    try {
        const { hashPassword } = await import("./auth");
        const hashedPassword = hashPassword(newPassword);
        const response = await fetch(`/api/users/${username}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: hashedPassword }),
        });
        return response.ok;
    }
    catch {
        return false;
    }
}
