import { validatePassword } from "@/lib/auth"

interface PasswordStrengthProps {
  password: string
}

export function PasswordStrength({ password }: PasswordStrengthProps) {
  const { strength, errors } = validatePassword(password)

  const getStrengthColor = () => {
    switch (strength) {
      case "strong":
        return "bg-green-500"
      case "medium":
        return "bg-yellow-500"
      default:
        return "bg-red-500"
    }
  }

  const getStrengthWidth = () => {
    switch (strength) {
      case "strong":
        return "w-full"
      case "medium":
        return "w-2/3"
      default:
        return "w-1/3"
    }
  }

  if (!password) return null

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm text-muted-foreground">Password strength:</span>
        <span
          className={`text-sm font-medium ${
            strength === "strong" ? "text-green-600" : strength === "medium" ? "text-yellow-600" : "text-red-600"
          }`}
        >
          {strength.charAt(0).toUpperCase() + strength.slice(1)}
        </span>
      </div>
      <div className="w-full bg-muted rounded-full h-2">
        <div className={`h-2 rounded-full transition-all ${getStrengthColor()} ${getStrengthWidth()}`} />
      </div>
      {errors.length > 0 && (
        <ul className="mt-1 text-sm text-red-600">
          {errors.map((error, index) => (
            <li key={index}>• {error}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
