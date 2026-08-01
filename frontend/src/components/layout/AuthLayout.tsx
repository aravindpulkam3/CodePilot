import { ReactNode } from "react";
import { Terminal } from "lucide-react";

/**
 * Shared shell for Login/Signup: a centered panel over the dot-grid
 * background, with the product mark above it. Clerk's <SignIn />/<SignUp />
 * render inside `children` and inherit color tokens from the
 * `appearance.variables` set in ClerkProviderWrapper.
 */
export function AuthLayout({ children, tagline }: { children: ReactNode; tagline: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-grid bg-canvas-light px-4 dark:bg-canvas-dark">
      <div className="flex w-full max-w-sm flex-col items-center">
        <div className="mb-6 flex flex-col items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-signal-600 text-white">
            <Terminal size={20} strokeWidth={2.5} />
          </div>
          <p className="text-center text-sm text-muted-light dark:text-muted-dark">{tagline}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
