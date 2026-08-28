import { repositoryGraphService } from "./repositoryGraph.service.js";

export class RelatedTestDiscoveryService {
  /**
   * Discovers and ranks test files that import or are likely related to the given file.
   */
  public async discoverTestsForFile(repositoryId: string, filePath: string): Promise<string[]> {
    // 1. Get all files that import this file (dependents)
    const dependents = await repositoryGraphService.getDirectDependents(repositoryId, filePath);

    // 2. Filter for files that look like tests
    const testFiles = dependents.filter((dep) => this.isTestFile(dep));

    // Optional: Sort or rank tests if needed
    // Currently returns all test dependents
    return testFiles;
  }

  private isTestFile(filePath: string): boolean {
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
