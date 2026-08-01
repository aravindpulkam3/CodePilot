import { Link } from "react-router-dom";
import { ROUTES } from "@/constants/routes";
import { Button } from "@/components/ui/Button";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-grid bg-canvas-light px-4 text-center dark:bg-canvas-dark">
      <p className="font-mono text-sm text-signal-600">error · route_not_found</p>
      <h1 className="mt-2 font-display text-6xl font-bold text-ink-light dark:text-ink-dark">
        404
      </h1>
      <p className="mt-3 max-w-sm text-sm text-muted-light dark:text-muted-dark">
        This path doesn't resolve to anything in the workspace.
      </p>
      <Link to={ROUTES.landing} className="mt-6">
        <Button variant="secondary">Back to home</Button>
      </Link>
    </div>
  );
}
