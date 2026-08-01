import { ClerkProvider } from "@clerk/clerk-react";
import { ReactNode } from "react";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!PUBLISHABLE_KEY) {
  // Fails fast in dev so a missing key never silently ships as a broken
  // auth screen. Set VITE_CLERK_PUBLISHABLE_KEY in frontend/.env.local —
  // see README "Configuring Clerk".
  throw new Error(
    "Missing VITE_CLERK_PUBLISHABLE_KEY. Add it to frontend/.env.local (see .env.example)."
  );
}

/**
 * Wraps the app in Clerk's provider. Client-side routing for auth flows
 * is handled by `routing="path"` on <SignIn>/<SignUp> in the Login and
 * Signup pages themselves (Clerk v5's routing model) — this wrapper only
 * needs to carry the publishable key and shared appearance tokens.
 */
export function ClerkProviderWrapper({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      appearance={{
        variables: {
          colorPrimary: "#0D9488",
          fontFamily: "'Inter', sans-serif",
          borderRadius: "8px",
        },
      }}
    >
      {children}
    </ClerkProvider>
  );
}
