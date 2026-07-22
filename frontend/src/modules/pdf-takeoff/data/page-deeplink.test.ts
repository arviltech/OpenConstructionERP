import { describe, it, expect } from 'vitest';
import {
  parsePageParam,
  resolveInitialPage,
  clampPage,
  pageParamForUrl,
} from './page-deeplink';

describe('page-deeplink (current-page URL round trip)', () => {
  describe('parsePageParam', () => {
    it('reads a positive integer page', () => {
      expect(parsePageParam('3')).toBe(3);
      expect(parsePageParam('1')).toBe(1);
    });

    it('is undefined for absent, zero, negative or non-numeric values', () => {
      expect(parsePageParam(null)).toBeUndefined();
      expect(parsePageParam(undefined)).toBeUndefined();
      expect(parsePageParam('')).toBeUndefined();
      expect(parsePageParam('0')).toBeUndefined();
      expect(parsePageParam('-2')).toBeUndefined();
      expect(parsePageParam('abc')).toBeUndefined();
    });

    it('takes the leading integer of a decimal or trailing-garbage value', () => {
      // parseInt semantics: a restored page is always a whole sheet number.
      expect(parsePageParam('4.9')).toBe(4);
      expect(parsePageParam('12px')).toBe(12);
    });
  });

  describe('resolveInitialPage (document scoping)', () => {
    it('applies the page only while the deep-linked document is shown', () => {
      expect(resolveInitialPage('docA', 'docA', 3)).toBe(3);
    });

    it('does NOT carry the page onto a different document', () => {
      // The regression: a filmstrip switch to docB must not restore docA's
      // deep-linked page onto docB (the viewer remounts, the host page does not).
      expect(resolveInitialPage('docB', 'docA', 3)).toBeUndefined();
    });

    it('is undefined when no document is shown yet, or no doc was deep-linked', () => {
      expect(resolveInitialPage(undefined, 'docA', 3)).toBeUndefined();
      expect(resolveInitialPage(null, 'docA', 3)).toBeUndefined();
      expect(resolveInitialPage('docA', null, 3)).toBeUndefined();
    });

    it('is undefined when there is no deep-linked page', () => {
      expect(resolveInitialPage('docA', 'docA', undefined)).toBeUndefined();
    });
  });

  describe('clampPage', () => {
    it('keeps an in-range page unchanged', () => {
      expect(clampPage(3, 11)).toBe(3);
    });

    it('clamps below 1 up to 1 and above numPages down to numPages', () => {
      expect(clampPage(0, 11)).toBe(1);
      expect(clampPage(-5, 11)).toBe(1);
      expect(clampPage(99, 11)).toBe(11);
    });
  });

  describe('pageParamForUrl', () => {
    it('drops the param at page 1 for a clean URL', () => {
      expect(pageParamForUrl(1)).toBeNull();
      expect(pageParamForUrl(0)).toBeNull();
    });

    it('writes the page string past page 1', () => {
      expect(pageParamForUrl(2)).toBe('2');
      expect(pageParamForUrl(11)).toBe('11');
    });
  });
});
