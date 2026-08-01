import { useUser } from "@clerk/clerk-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";

/**
 * Displays identity fields Clerk already gives us via useUser() — this is
 * read-only presentation, not a settings form, so it stays within the
 * "blueprint page" scope while still being useful. Editable profile
 * fields are a future milestone.
 */
export default function Profile() {
  const { isLoaded, user } = useUser();

  return (
    <div>
      <PageHeader title="Profile" description="Your account identity, as managed by Clerk." />

      <Card className="max-w-xl">
        <CardBody className="flex items-center gap-4 py-6">
          {!isLoaded ? (
            <Spinner className="h-5 w-5 text-signal-600" />
          ) : (
            <>
              <img
                src={user?.imageUrl}
                alt=""
                className="h-14 w-14 rounded-full border border-border-light dark:border-border-dark"
              />
              <div className="min-w-0">
                <p className="truncate text-base font-medium text-ink-light dark:text-ink-dark">
                  {user?.fullName ?? "Unnamed user"}
                </p>
                <p className="truncate text-sm text-muted-light dark:text-muted-dark">
                  {user?.primaryEmailAddress?.emailAddress}
                </p>
                <div className="mt-2 flex gap-1.5">
                  {user?.externalAccounts.some((a) => a.provider === "github") && (
                    <Badge tone="signal">GitHub connected</Badge>
                  )}
                  <Badge tone="neutral">
                    Joined {user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—"}
                  </Badge>
                </div>
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
