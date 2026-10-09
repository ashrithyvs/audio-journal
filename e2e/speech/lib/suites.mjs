// Named subsets of the prepared speech dataset, shared by every runner.

export const SUITES = ['smoke', 'standard', 'noise', 'long', 'full'];

export function suiteItems(manifest, suite) {
  const items = manifest.items;
  const firstPerSpeaker = (set, condition) => {
    const seen = new Set();
    return items.filter(item => {
      if (
        item.set !== set ||
        item.condition !== condition ||
        seen.has(item.speakerId)
      )
        return false;
      seen.add(item.speakerId);
      return true;
    });
  };
  switch (suite) {
    case 'smoke':
      // 20 speakers, clean read speech.
      return firstPerSpeaker('test-clean', 'clean').slice(0, 20);
    case 'standard':
      return items.filter(
        item =>
          (item.set === 'test-clean' &&
            ['clean', 'babble10', 'quiet'].includes(item.condition)) ||
          (item.set === 'test-other' && item.condition === 'clean'),
      );
    case 'noise':
      return items.filter(
        item =>
          item.set === 'test-clean' &&
          item.condition !== 'clean' &&
          !item.condition.startsWith('long'),
      );
    case 'long':
      return items.filter(item => item.condition.startsWith('long'));
    case 'full':
      return items;
    default:
      throw new Error(`unknown suite ${suite}`);
  }
}
