"use client"

import { useEffect } from "react"

export function UnderwaterEffects() {
  useEffect(() => {
    let layer: HTMLElement | null = null
    const ensureLayer = () => {
      layer = document.getElementById("bubble-layer") || document.body
    }
    ensureLayer()
  const createBubble = () => {
      const bubble = document.createElement("div")
      bubble.className = "bubble"

  // Larger bubbles: random size between 25px and 95px
  const size = Math.random() * 70 + 25
      bubble.style.width = `${size}px`
      bubble.style.height = `${size}px`

      bubble.style.left = `${Math.random() * 100}%`
      bubble.style.bottom = "-50px" // Start below the viewport
      bubble.style.top = "auto" // Remove any top positioning

  // Slightly longer animation for larger bubbles: 10 - 20s
  const duration = Math.random() * 10 + 10
  bubble.dataset.duration = String(duration)
  bubble.style.animationDuration = `${duration}s, ${duration * 0.5}s`

  // Use a negative delay so each bubble appears mid-cycle (prevents "burst" on mount)
  const floatOffset = Math.random() * duration
  const swayDelay = Math.random() * 3
  bubble.style.animationDelay = `-${floatOffset}s, ${swayDelay}s`

  ;(layer || document.body).appendChild(bubble)

      // On each animation loop, randomize horizontal position & sway delay for variety
      bubble.addEventListener("animationiteration", (e) => {
        // Only act on the primary float animation (first in list)
        if ((e as AnimationEvent).animationName === "bubble-float") {
          bubble.style.left = `${Math.random() * 100}%`
          const newDelay = Math.random() * 3
          // Preserve first animation delay 0s for float; set second (sway)
          // Keep float animation continuous (no reset); only randomize sway phase
          bubble.style.animationDelay = `${bubble.style.animationDelay.split(",")[0]}, ${newDelay}s`
        }
      })
    }

    const createParticle = () => {
      const particle = document.createElement("div")
      particle.className = "floating-particle"

      // Smaller particles than bubbles
      const size = Math.random() * 4 + 2
      particle.style.width = `${size}px`
      particle.style.height = `${size}px`

      particle.style.left = `${Math.random() * 100}%`
      particle.style.bottom = "-20px" // Start below the viewport
      particle.style.top = "auto" // Remove any top positioning

      // Faster animation for particles
      const duration = Math.random() * 8 + 10
      particle.style.animationDuration = `${duration}s`

  ;(layer || document.body).appendChild(particle)

      setTimeout(() => {
        if (particle.parentNode) {
          particle.parentNode.removeChild(particle)
        }
      }, duration * 1000)
    }

  // Create an initial, fixed pool of persistent bubbles (reduced to 15)
  const BUBBLE_COUNT = 15
    for (let i = 0; i < BUBBLE_COUNT; i++) {
      // Stagger creation so they are naturally distributed
      setTimeout(() => createBubble(), i * 350)
    }

    // Create initial particles
    for (let i = 0; i < 5; i++) {
      setTimeout(() => createParticle(), i * 1200)
    }

    // Continue creating particles occasionally (lighter effect)
    const particleInterval = setInterval(createParticle, 4000)

    // On returning to the tab, re-randomize phases so there is no synchronized rush
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        const bubbles = (layer || document.body).querySelectorAll<HTMLElement>(".bubble")
        bubbles.forEach((b) => {
          const d = parseFloat(b.dataset.duration || "15")
          const floatOffset = Math.random() * d
            // Preserve sway second delay if present
          const parts = b.style.animationDelay.split(",")
          const sway = parts[1] ? parts[1].trim() : `${Math.random() * 3}s`
          b.style.animationDelay = `-${floatOffset}s, ${sway}`
        })
      }
    }
    document.addEventListener("visibilitychange", handleVisibility)

    return () => {
  clearInterval(particleInterval)
  document.removeEventListener("visibilitychange", handleVisibility)
      // Clean up existing bubbles and particles
  const activeLayer = layer || document.body
  const bubbles = activeLayer.querySelectorAll(".bubble")
  const particles = activeLayer.querySelectorAll(".floating-particle")
      bubbles.forEach((bubble) => bubble.remove())
      particles.forEach((particle) => particle.remove())
    }
  }, [])

  return null
}
