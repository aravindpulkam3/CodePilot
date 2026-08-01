/** Tiny classnames joiner — avoids pulling in `clsx` for one function. */
export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}
