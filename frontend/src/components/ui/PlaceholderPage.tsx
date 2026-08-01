import { PageHeader } from "./PageHeader";
import { Card, CardBody } from "./Card";

/**
 * Blueprint page body: title, description, and a quiet "not built yet"
 * panel. Every top-level page (Dashboard, Repositories, ...) renders one
 * of these until its real feature lands — swap the children in, the
 * shell stays.
 */
export function PlaceholderPage({
  title,
  description,
  note,
}: {
  title: string;
  description: string;
  note?: string;
}) {
  return (
    <div>
      <PageHeader title={title} description={description} />
      <Card className="bg-grid">
        <CardBody className="flex min-h-[220px] flex-col items-center justify-center gap-2 py-16 text-center">
          <div className="mb-1 h-8 w-8 rounded-md border border-dashed border-border-light dark:border-border-dark" />
          <p className="text-sm font-medium text-ink-light dark:text-ink-dark">
            Nothing built here yet
          </p>
          <p className="max-w-sm text-xs text-muted-light dark:text-muted-dark">
            {note ?? "This section is reserved for a future milestone."}
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
