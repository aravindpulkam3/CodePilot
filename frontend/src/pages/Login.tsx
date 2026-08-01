import { SignIn } from "@clerk/clerk-react";
import { AuthLayout } from "@/components/layout/AuthLayout";
import { ROUTES } from "@/constants/routes";

/**
 * Clerk's <SignIn /> renders both auth methods configured in the Clerk
 * Dashboard — email/password and "Continue with GitHub" — as well as
 * email verification and "Forgot password?" flows, with no extra code
 * here. See README → "Configuring Clerk" for enabling GitHub OAuth.
 */
export default function Login() {
  return (
    <AuthLayout tagline="Sign in to your engineering workspace">
      <SignIn
        path={ROUTES.login}
        routing="path"
        signUpUrl={ROUTES.signup}
        forceRedirectUrl={ROUTES.dashboard}
      />
    </AuthLayout>
  );
}
