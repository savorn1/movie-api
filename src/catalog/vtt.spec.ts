import { timestamp, toVtt } from './vtt';

describe('toVtt', () => {
  it('writes cues with escaped text', () => {
    expect(
      toVtt([
        { startMs: 0, endMs: 2500, text: 'សួស្តី <ពិភពលោក>' },
        { startMs: 3_723_004, endMs: 3_724_000, text: 'a & b --> c' },
      ]),
    ).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nសួស្តី &lt;ពិភពលោក>\n\n' +
        '01:02:03.004 --> 01:02:04.000\na &amp; b --&gt; c\n\n',
    );
  });

  it('formats long timestamps', () => {
    expect(timestamp(100 * 3_600_000 + 1)).toBe('100:00:00.001');
  });
});
