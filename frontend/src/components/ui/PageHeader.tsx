export function PageHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-8 max-w-2xl">
      <h1 className="text-2xl font-semibold text-ink-light dark:text-ink-dark">{title}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-light dark:text-muted-dark">
        {description}
      </p>
    </div>
  );
}
