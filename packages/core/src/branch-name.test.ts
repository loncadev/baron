import { describe, expect, it } from 'vitest';
import { deriveBranchName, slugifyTitle } from './branch-name.js';

describe('slugifyTitle', () => {
  it('folds Turkish characters and collapses punctuation to dashes', () => {
    expect(
      slugifyTitle(
        'Ürün ekleme sayfasında kategori ve markalarda search yok büyük veri gelirse sorun olabilir.',
      ),
    ).toBe('urun-ekleme-sayfasinda-kategori-ve-markalarda-search-yok');
  });

  it('handles the dotted/dotless I pair (İ→i, ı→i) that NFD alone misses', () => {
    expect(slugifyTitle('İstanbul ılık')).toBe('istanbul-ilik');
  });

  it('folds general diacritics via NFD (é→e, ü→u)', () => {
    expect(slugifyTitle('Détails über çağrı')).toBe('details-uber-cagri');
  });

  it('truncates at a word boundary, never mid-word', () => {
    const slug = slugifyTitle(
      'a very long title that keeps going and going until it exceeds sixty characters easily',
    );
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
    // the cut must land on a word boundary: the original words up to the cut are intact
    expect('a-very-long-title-that-keeps-going-and-going-until-it-exceeds'.startsWith(slug)).toBe(
      true,
    );
  });

  it('returns empty for a title with no alphanumerics', () => {
    expect(slugifyTitle('!!! ???')).toBe('');
  });
});

describe('deriveBranchName', () => {
  it('derives <prefix>/<id>-<slug> from the type role (reference example)', () => {
    expect(
      deriveBranchName({
        id: '640',
        title:
          'Ürün ekleme sayfasında kategori ve markalarda search yok büyük veri gelirse sorun olabilir.',
        typeRole: 'bug',
      }),
    ).toBe('bug/640-urun-ekleme-sayfasinda-kategori-ve-markalarda-search-yok');
  });

  it('maps story→feature and task/subtask→task', () => {
    expect(deriveBranchName({ id: '1', title: 'Add search', typeRole: 'story' })).toBe(
      'feature/1-add-search',
    );
    expect(deriveBranchName({ id: '2', title: 'Wire CI', typeRole: 'task' })).toBe(
      'task/2-wire-ci',
    );
    expect(deriveBranchName({ id: '3', title: 'Split step', typeRole: 'subtask' })).toBe(
      'task/3-split-step',
    );
  });

  it('refuses container types and unmapped types (undefined, never invented)', () => {
    expect(deriveBranchName({ id: '9', title: 'Big theme', typeRole: 'epic' })).toBeUndefined();
    expect(
      deriveBranchName({ id: '9', title: 'Bigger theme', typeRole: 'initiative' }),
    ).toBeUndefined();
    expect(deriveBranchName({ id: '9', title: 'No mapping', typeRole: undefined })).toBeUndefined();
  });

  it('omits the slug segment when the title yields none', () => {
    expect(deriveBranchName({ id: '7', title: '!!!', typeRole: 'task' })).toBe('task/7');
  });
});
