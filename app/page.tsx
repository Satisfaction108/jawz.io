"use client"

import type React from "react"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SharkLogo } from "@/components/shark-logo"
import { PasswordStrength } from "@/components/password-strength"
import { UnderwaterEffects } from "@/components/underwater-effects"
import { validatePassword, hashPassword } from "@/lib/auth"
import { saveUser, authenticateUser, updateUserPassword } from "@/lib/user-storage"
import type { UserData } from "@/lib/auth"

import GameCanvas from "@/components/game/GameCanvas"

export default function HomePage() {
  const [currentView, setCurrentView] = useState<"home" | "login" | "signup" | "dashboard" | "game">("home")
  const [user, setUser] = useState<UserData | null>(null)

  // Form states
  const [loginForm, setLoginForm] = useState({ username: "", password: "" })
  const [signupForm, setSignupForm] = useState({
    username: "",
    password: "",
    confirmPassword: "",
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError("")

    try {
      const userData = await authenticateUser(loginForm.username, loginForm.password)
      if (userData) {
        setUser(userData)
        setCurrentView("dashboard")
      } else {
        setError("Invalid username or password")
      }
    } catch {
      setError("Login failed. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError("")

    const { isValid, errors } = validatePassword(signupForm.password)

    if (!isValid) {
      setError(errors.join(", "))
      setLoading(false)
      return
    }

    if (signupForm.password !== signupForm.confirmPassword) {
      setError("Passwords do not match")
      setLoading(false)
      return
    }

    try {
      const hashedPassword = hashPassword(signupForm.password)
      const success = await saveUser({
        username: signupForm.username,
        password: hashedPassword,
        timeCreated: new Date().toISOString(),
      })

      if (success) {
        setUser({
          username: signupForm.username,
          timeCreated: new Date().toISOString(),
        })
        setCurrentView("dashboard")
      } else {
        setError("Username already exists or signup failed")
      }
    } catch {
      setError("Signup failed. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  if (user) {
    if (currentView === "game") {
      return <GameCanvas username={user.username} />
    }
    
    if (currentView === "dashboard") {
      return (
        <Dashboard
          user={user}
          onLogout={() => {
            setUser(null)
            setCurrentView("home")
            setLoginForm({ username: "", password: "" })
            setSignupForm({ username: "", password: "", confirmPassword: "" })
          }}
          onPlay={() => setCurrentView("game")}
        />
      )
    }
  }

  return (
    <div className="min-h-screen underwater-bg relative">
      <div id="bubble-layer" className="pointer-events-none absolute inset-0 z-0" aria-hidden="true" />
      <UnderwaterEffects />

      {/* Header */}
      <header className="border-b bg-card/80 backdrop-blur-md relative z-10">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <SharkLogo className="w-10 h-10 text-primary drop-shadow-lg" />
            <h1 className="text-2xl font-bold text-primary drop-shadow-sm">Jawz.io</h1>
          </div>

          {currentView === "home" && (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setCurrentView("login")} className="backdrop-blur-sm">
                Login
              </Button>
              <Button onClick={() => setCurrentView("signup")} className="shadow-lg">
                Sign Up
              </Button>
            </div>
          )}

          {(currentView === "login" || currentView === "signup") && (
            <Button variant="outline" onClick={() => setCurrentView("home")} className="backdrop-blur-sm">
              Back
            </Button>
          )}
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 relative z-10">
        {currentView === "home" && (
          <div className="text-center space-y-8">
            {/* Hero Section */}
            <div className="space-y-4">
              <SharkLogo className="w-24 h-24 mx-auto text-primary drop-shadow-2xl" />
              <h2 className="text-4xl font-bold text-balance drop-shadow-sm">Dive Into the Adventure</h2>
              <p className="text-xl text-muted-foreground text-pretty max-w-2xl mx-auto drop-shadow-sm">
                Join the ultimate underwater gaming experience. Hunt, survive, and dominate the ocean depths in Jawz.io!
              </p>
              <Button
                size="lg"
                className="text-lg px-8 shadow-xl hover:shadow-2xl transition-all duration-300"
                onClick={() => setCurrentView("signup")}
              >
                Join the Hunt
              </Button>
            </div>

            {/* Features */}
            <div className="grid md:grid-cols-3 gap-6 mt-16">
              <Card className="underwater-card hover:shadow-2xl transition-all duration-300">
                <CardHeader>
                  <CardTitle className="text-primary">Multiplayer Action</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground">Battle other players in real-time underwater combat</p>
                </CardContent>
              </Card>

              <Card className="underwater-card hover:shadow-2xl transition-all duration-300">
                <CardHeader>
                  <CardTitle className="text-primary">Evolution System</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground">Grow and evolve your shark to become the apex predator</p>
                </CardContent>
              </Card>

              <Card className="underwater-card hover:shadow-2xl transition-all duration-300">
                <CardHeader>
                  <CardTitle className="text-primary">Ocean Exploration</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground">Discover hidden treasures in the vast ocean depths</p>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {currentView === "login" && (
          <div className="max-w-md mx-auto">
            <Card className="underwater-card shadow-2xl card-fade-in">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-primary">
                  <SharkLogo className="w-6 h-6" />
                  Login to Jawz.io
                </CardTitle>
                <CardDescription>Enter your credentials to access your account</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleLogin} className="space-y-4">
                  <div>
                    <Label htmlFor="username">Username</Label>
                    <Input
                      id="username"
                      value={loginForm.username}
                      onChange={(e) => setLoginForm((prev) => ({ ...prev, username: e.target.value }))}
                      required
                      className="backdrop-blur-sm"
                    />
                  </div>

                  <div>
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      value={loginForm.password}
                      onChange={(e) => setLoginForm((prev) => ({ ...prev, password: e.target.value }))}
                      required
                      className="backdrop-blur-sm"
                    />
                  </div>

                  {error && <p className="text-sm text-destructive">{error}</p>}

                  <Button
                    type="submit"
                    className="w-full shadow-lg hover:shadow-xl transition-all duration-300"
                    disabled={loading}
                  >
                    {loading ? "Logging in..." : "Login"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>
        )}

        {currentView === "signup" && (
          <div className="max-w-md mx-auto">
            <Card className="underwater-card shadow-2xl font-extralight text-slate-500 card-fade-in">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-primary">
                  <SharkLogo className="w-6 h-6" />
                  Join Jawz.io
                </CardTitle>
                <CardDescription>Create your account to start playing</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSignup} className="space-y-4">
                  <div>
                    <Label htmlFor="signup-username">Username</Label>
                    <Input
                      id="signup-username"
                      value={signupForm.username}
                      onChange={(e) => setSignupForm((prev) => ({ ...prev, username: e.target.value }))}
                      required
                      className="backdrop-blur-sm"
                    />
                  </div>

                  <div>
                    <Label htmlFor="signup-password">Password</Label>
                    <Input
                      id="signup-password"
                      type="password"
                      value={signupForm.password}
                      onChange={(e) => setSignupForm((prev) => ({ ...prev, password: e.target.value }))}
                      required
                      className="backdrop-blur-sm"
                    />
                    <PasswordStrength password={signupForm.password} />
                  </div>

                  <div>
                    <Label htmlFor="confirm-password">Confirm Password</Label>
                    <Input
                      id="confirm-password"
                      type="password"
                      value={signupForm.confirmPassword}
                      onChange={(e) => setSignupForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
                      required
                      className="backdrop-blur-sm"
                    />
                  </div>

                  {error && <p className="text-sm text-destructive">{error}</p>}

                  <Button
                    type="submit"
                    className="w-full shadow-lg hover:shadow-xl transition-all duration-300"
                    disabled={loading}
                  >
                    {loading ? "Creating Account..." : "Create Account"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>
        )}
      </main>
    </div>
  )
}

// Dashboard component for post-login
function Dashboard({ user, onLogout, onPlay }: { user: UserData; onLogout: () => void; onPlay: () => void }) {
  const router = useRouter();
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [showAccountModal, setShowAccountModal] = useState(false)
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)
  const [showPasswordReset, setShowPasswordReset] = useState(false)
  const [showLeaderboard, setShowLeaderboard] = useState(false)
  const [passwordResetForm, setPasswordResetForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  })
  const [resetLoading, setResetLoading] = useState(false)
  const [resetError, setResetError] = useState("")
  const [resetSuccess, setResetSuccess] = useState(false)

  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault()
    setResetLoading(true)
    setResetError("")
    setResetSuccess(false)

    const authResult = await authenticateUser(user.username, passwordResetForm.currentPassword)
    if (!authResult) {
      setResetError("Current password is incorrect")
      setResetLoading(false)
      return
    }

    const { isValid, errors } = validatePassword(passwordResetForm.newPassword)
    if (!isValid) {
      setResetError(errors.join(", "))
      setResetLoading(false)
      return
    }

    if (passwordResetForm.newPassword !== passwordResetForm.confirmPassword) {
      setResetError("New passwords do not match")
      setResetLoading(false)
      return
    }

    try {
      const success = await updateUserPassword(user.username, passwordResetForm.newPassword)
      if (success) {
        setResetSuccess(true)
        setPasswordResetForm({ currentPassword: "", newPassword: "", confirmPassword: "" })
        setTimeout(() => {
          setShowPasswordReset(false)
          setResetSuccess(false)
        }, 2000)
      } else {
        setResetError("Failed to update password")
      }
    } catch {
      setResetError("Password reset failed. Please try again.")
    } finally {
      setResetLoading(false)
    }
  }

  return (
    <div className="min-h-screen underwater-bg relative">
      <UnderwaterEffects />

      <header className="border-b bg-card/80 backdrop-blur-md relative z-20">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <SharkLogo className="w-10 h-10 text-primary drop-shadow-lg" />
            <h1 className="text-2xl font-bold text-primary drop-shadow-sm">Jawz.io</h1>
          </div>

          <div className="flex items-center gap-4">
            <Button
              onClick={onPlay}
              className="bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg hover:shadow-xl transition-all duration-300"
            >
              Play
            </Button>
            
            <div className="relative">
            <button
              onClick={() => setShowProfileMenu(!showProfileMenu)}
              className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg hover:shadow-xl transition-all duration-300 relative z-50"
            >
              <SharkLogo className="w-6 h-6" />
            </button>

            {showProfileMenu && (
              <div
                className="absolute right-0 mt-2 w-48 bg-card/95 backdrop-blur-md border rounded-md shadow-xl z-[9999] dropdown-menu pointer-events-auto"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowAccountModal(true)
                    setShowProfileMenu(false)
                  }}
                  className="w-full px-4 py-3 text-left hover:bg-accent hover:text-accent-foreground transition-colors duration-200 rounded-t-md pointer-events-auto relative z-[9999] block cursor-pointer"
                  style={{ pointerEvents: "auto" }}
                >
                  Account
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowLogoutConfirm(true)
                    setShowProfileMenu(false)
                  }}
                  className="w-full px-4 py-3 text-left hover:bg-accent hover:text-accent-foreground transition-colors duration-200 rounded-b-md pointer-events-auto relative z-[9999] block cursor-pointer"
                  style={{ pointerEvents: "auto" }}
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 relative z-10">
        <div className="text-center space-y-8">
          <div>
            <h2 className="text-3xl font-bold mb-2 drop-shadow-sm">Welcome back, {user.username}!</h2>
            <p className="text-muted-foreground drop-shadow-sm">Ready to dominate the ocean?</p>
          </div>

          <div className="grid md:grid-cols-2 gap-6 max-w-4xl mx-auto">
            <Card className="underwater-card hover:shadow-2xl transition-all duration-300">
              <CardHeader>
                <CardTitle className="text-primary">Quick Play</CardTitle>
                <CardDescription>Jump into a game instantly</CardDescription>
              </CardHeader>
              <CardContent>
                <Button className="w-full shadow-lg hover:shadow-xl transition-all duration-300">Start Game</Button>
              </CardContent>
            </Card>

            <Card className="underwater-card hover:shadow-2xl transition-all duration-300">
              <CardHeader>
                <CardTitle className="text-primary">Leaderboard</CardTitle>
                <CardDescription>See top players</CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  variant="outline"
                  className="w-full bg-transparent backdrop-blur-sm shadow-lg hover:shadow-xl transition-all duration-300"
                  onClick={() => setShowLeaderboard(true)}
                >
                  View Rankings
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      {showAccountModal && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center z-[10000] modal-backdrop">
          <Card className="w-full max-w-md mx-4 bg-card/98 backdrop-blur-xl border-2 border-primary/20 shadow-2xl modal-content">
            <CardHeader className="bg-primary/5 rounded-t-lg">
              <CardTitle className="text-primary font-bold">Account Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 bg-card/95 rounded-b-lg">
              <div>
                <Label>Username</Label>
                <p className="text-sm text-muted-foreground">{user.username}</p>
              </div>
              <div>
                <Label>Member Since</Label>
                <p className="text-sm text-muted-foreground">{new Date(user.timeCreated).toLocaleDateString()}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1 bg-transparent backdrop-blur-sm"
                  onClick={() => {
                    setShowAccountModal(false)
                    setShowPasswordReset(true)
                  }}
                >
                  Reset Password
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowAccountModal(false)}
                  className="flex-1 backdrop-blur-sm"
                >
                  Close
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {showPasswordReset && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center z-[10000] modal-backdrop">
          <Card className="w-full max-w-md mx-4 bg-card/98 backdrop-blur-xl border-2 border-primary/20 shadow-2xl modal-content">
            <CardHeader className="bg-primary/5 rounded-t-lg">
              <CardTitle className="text-primary font-bold">Reset Password</CardTitle>
              <CardDescription className="text-foreground/80">
                Enter your current password and choose a new one
              </CardDescription>
            </CardHeader>
            <CardContent className="bg-card/95 rounded-b-lg">
              {resetSuccess ? (
                <div className="text-center py-4">
                  <p className="text-accent font-medium">Password updated successfully!</p>
                </div>
              ) : (
                <form onSubmit={handlePasswordReset} className="space-y-4">
                  <div>
                    <Label htmlFor="current-password">Current Password</Label>
                    <Input
                      id="current-password"
                      type="password"
                      value={passwordResetForm.currentPassword}
                      onChange={(e) => setPasswordResetForm((prev) => ({ ...prev, currentPassword: e.target.value }))}
                      required
                      className="backdrop-blur-sm"
                    />
                  </div>

                  <div>
                    <Label htmlFor="new-password">New Password</Label>
                    <Input
                      id="new-password"
                      type="password"
                      value={passwordResetForm.newPassword}
                      onChange={(e) => setPasswordResetForm((prev) => ({ ...prev, newPassword: e.target.value }))}
                      required
                      className="backdrop-blur-sm"
                    />
                    <PasswordStrength password={passwordResetForm.newPassword} />
                  </div>

                  <div>
                    <Label htmlFor="confirm-new-password">Confirm New Password</Label>
                    <Input
                      id="confirm-new-password"
                      type="password"
                      value={passwordResetForm.confirmPassword}
                      onChange={(e) => setPasswordResetForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
                      required
                      className="backdrop-blur-sm"
                    />
                  </div>

                  {resetError && <p className="text-sm text-destructive">{resetError}</p>}

                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setShowPasswordReset(false)
                        setPasswordResetForm({ currentPassword: "", newPassword: "", confirmPassword: "" })
                        setResetError("")
                      }}
                      className="flex-1 backdrop-blur-sm"
                    >
                      Cancel
                    </Button>
                    <Button type="submit" disabled={resetLoading} className="flex-1 shadow-lg">
                      {resetLoading ? "Updating..." : "Update Password"}
                    </Button>
                  </div>
                </form>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {showLogoutConfirm && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center z-[10000] modal-backdrop">
          <Card className="w-full max-w-sm mx-4 bg-card/98 backdrop-blur-xl border-2 border-primary/20 shadow-2xl modal-content">
            <CardHeader className="bg-primary/5 rounded-t-lg">
              <CardTitle className="text-primary font-bold">Confirm Logout</CardTitle>
              <CardDescription className="text-foreground/80">Are you sure you want to log out?</CardDescription>
            </CardHeader>
            <CardContent className="flex gap-2 bg-card/95 rounded-b-lg">
              <Button variant="outline" onClick={() => setShowLogoutConfirm(false)} className="flex-1 backdrop-blur-sm">
                Cancel
              </Button>
              <Button onClick={onLogout} className="flex-1 shadow-lg">
                Logout
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {showLeaderboard && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center z-[10000] modal-backdrop">
          <Card className="w-full max-w-4xl mx-4 bg-card/98 backdrop-blur-xl border-2 border-primary/20 shadow-2xl modal-content max-h-[80vh] overflow-hidden">
            <CardHeader className="bg-primary/5 rounded-t-lg border-b border-primary/10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-yellow-400 to-yellow-600 flex items-center justify-center shadow-lg">
                    <span className="text-yellow-900 font-bold text-sm">👑</span>
                  </div>
                  <CardTitle className="text-primary font-bold text-2xl">Ocean Leaderboard</CardTitle>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowLeaderboard(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  ✕
                </Button>
              </div>
              <CardDescription className="text-foreground/80">Top predators of the deep blue sea</CardDescription>
            </CardHeader>
            <CardContent className="bg-card/95 rounded-b-lg p-0 overflow-y-auto max-h-[60vh]">
              <div className="p-6">
                {/* Leaderboard Header */}
                <div className="grid grid-cols-12 gap-4 mb-4 pb-3 border-b border-primary/20 text-sm font-semibold text-muted-foreground">
                  <div className="col-span-2 text-center">Rank</div>
                  <div className="col-span-1"></div>
                  <div className="col-span-4">Player</div>
                  <div className="col-span-3 text-center">Score</div>
                  <div className="col-span-2 text-center">Level</div>
                </div>

                {/* Empty State */}
                <div className="text-center py-16 space-y-4">
                  <div className="w-20 h-20 mx-auto rounded-full bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center">
                    <SharkLogo className="w-10 h-10 text-primary/60" />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-xl font-semibold text-foreground/80">The Ocean Awaits</h3>
                    <p className="text-muted-foreground max-w-md mx-auto">
                      No rankings yet! Be the first to make waves and claim your spot among the ocean's elite predators.
                    </p>
                  </div>
                  <div className="flex justify-center gap-2 pt-4">
                    <div className="w-2 h-2 rounded-full bg-primary/40 animate-pulse"></div>
                    <div
                      className="w-2 h-2 rounded-full bg-primary/40 animate-pulse"
                      style={{ animationDelay: "0.2s" }}
                    ></div>
                    <div
                      className="w-2 h-2 rounded-full bg-primary/40 animate-pulse"
                      style={{ animationDelay: "0.4s" }}
                    ></div>
                  </div>
                </div>

                {/* Sample Leaderboard Structure (commented out for empty state) */}
                {/* 
                <div className="space-y-2">
                  {[1, 2, 3, 4, 5].map((rank) => (
                    <div key={rank} className={`grid grid-cols-12 gap-4 p-3 rounded-lg transition-all duration-200 hover:bg-primary/5 ${
                      rank <= 3 ? 'bg-gradient-to-r from-primary/10 to-transparent border border-primary/20' : 'hover:bg-accent/50'
                    }`}>
                      <div className="col-span-2 flex items-center justify-center">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${
                          rank === 1 ? 'bg-gradient-to-br from-yellow-400 to-yellow-600 text-yellow-900' :
                          rank === 2 ? 'bg-gradient-to-br from-gray-300 to-gray-500 text-gray-800' :
                          rank === 3 ? 'bg-gradient-to-br from-amber-600 to-amber-800 text-amber-100' :
                          'bg-primary/20 text-primary'
                        }`}>
                          {rank <= 3 ? (rank === 1 ? '🥇' : rank === 2 ? '🥈' : '🥉') : rank}
                        </div>
                      </div>
                      <div className="col-span-1 flex items-center justify-center">
                        <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                          <SharkLogo className="w-5 h-5 text-primary" />
                        </div>
                      </div>
                      <div className="col-span-4 flex items-center">
                        <div>
                          <p className="font-semibold">Player {rank}</p>
                          <p className="text-xs text-muted-foreground">Apex Predator</p>
                        </div>
                      </div>
                      <div className="col-span-3 flex items-center justify-center">
                        <div className="text-center">
                          <p className="font-bold text-lg">{(1000 - rank * 50).toLocaleString()}</p>
                          <p className="text-xs text-muted-foreground">points</p>
                        </div>
                      </div>
                      <div className="col-span-2 flex items-center justify-center">
                        <div className="text-center">
                          <p className="font-semibold">{20 - rank}</p>
                          <p className="text-xs text-muted-foreground">level</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                */}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
