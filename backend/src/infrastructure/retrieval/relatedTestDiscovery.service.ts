export class RelatedTestDiscoveryService {
  /**
   * Path heuristic for test files. Review partitions the dependents it already
   * fetched from the import graph with this, so no extra graph query is needed.
   */
  public isTestFile(filePath: string): boolean {
    const lowerPath = filePath.toLowerCase();
    return (
      lowerPath.includes(".test.") ||
      lowerPath.includes(".spec.") ||
      lowerPath.includes("/tests/") ||
      lowerPath.includes("/__tests__/") ||
      lowerPath.endsWith("_test.go") ||
      lowerPath.endsWith("_test.py")
    );
  }
}

export const relatedTestDiscoveryService = new RelatedTestDiscoveryService();
