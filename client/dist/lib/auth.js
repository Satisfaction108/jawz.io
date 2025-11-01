// Password validation
export function validatePassword(password) {
    const errors = [];
    if (password.length < 6) {
        errors.push("Password must be at least 6 characters long");
    }
    if (!/\d/.test(password)) {
        errors.push("Password must contain at least 1 number");
    }
    const isValid = errors.length === 0;
    // Calculate strength
    let strength = "weak";
    if (password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password)) {
        strength = "strong";
    }
    else if (password.length >= 6 && /\d/.test(password)) {
        strength = "medium";
    }
    return { isValid, strength, errors };
}
// Hash password (simple implementation for demo)
export function hashPassword(password) {
    // In production, use bcrypt or similar
    return btoa(password + "jawz_salt");
}
// Verify password
export function verifyPassword(password, hash) {
    return hashPassword(password) === hash;
}
