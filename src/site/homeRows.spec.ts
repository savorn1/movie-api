import { homeRowsFrom } from './homeRows';

describe('homeRowsFrom', () => {
  it('turns the stored rows into what RuengFlix reads', () => {
    expect(
      homeRowsFrom([
        { title: 'អាប់ដេតថ្មី', source: 'LATEST', value: null, maxItems: 12 },
        {
          title: ' ក្បាច់គុន ',
          source: 'CATEGORY',
          value: 'CULTIVATION',
          maxItems: 8,
        },
        {
          title: 'យុទ្ធភព',
          source: 'GENRE',
          value: 'យុទ្ធភពបុរាណ',
          maxItems: 40,
        },
      ]),
    ).toEqual([
      { title: 'អាប់ដេតថ្មី', source: 'latest', value: null, max: 12 },
      { title: 'ក្បាច់គុន', source: 'category', value: 'cultivation', max: 8 },
      { title: 'យុទ្ធភព', source: 'genre', value: 'យុទ្ធភពបុរាណ', max: 30 },
    ]);
  });

  it('leaves out rows it could not show', () => {
    expect(
      homeRowsFrom([
        { title: 'x', source: 'SHORTS', value: null, maxItems: 12 },
        { title: 'x', source: 'CATEGORY', value: 'HORROR', maxItems: 12 },
        { title: 'x', source: 'GENRE', value: ' ', maxItems: 12 },
        { title: ' ', source: 'LATEST', value: null, maxItems: 12 },
      ]),
    ).toEqual([]);
  });
});
