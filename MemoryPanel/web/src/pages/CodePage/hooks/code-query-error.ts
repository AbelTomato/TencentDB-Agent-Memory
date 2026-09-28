/** Only explicit CodeGraph error codes can identify the index state. */
export function codeGraphQueryFailureMessage(
  error: unknown,
  translate: (key: string) => string,
): string | null {
  if (typeof error !== 'object' || error === null || !('errorCode' in error)) return null;

  switch (error.errorCode) {
    case 'CODE_GRAPH_INDEX_BUILDING':
      return translate('code.notify.queryBuilding');
    case 'CODE_GRAPH_INDEX_SWITCHING':
      return translate('code.notify.querySwitching');
    case 'CODE_GRAPH_INDEX_UNAVAILABLE':
      return translate('code.notify.queryUnavailable');
    case 'CODE_GRAPH_INDEX_FAILED':
      return translate('code.notify.queryFailed');
    default:
      return null;
  }
}
