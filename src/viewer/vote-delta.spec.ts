import { voteDelta } from './vote-delta';

describe('voteDelta', () => {
  it('adds a new vote', () => {
    expect(voteDelta(1, 0)).toEqual({ likes: 1, dislikes: 0 });
    expect(voteDelta(-1, 0)).toEqual({ likes: 0, dislikes: 1 });
  });

  it('moves a changed vote', () => {
    expect(voteDelta(-1, 1)).toEqual({ likes: -1, dislikes: 1 });
    expect(voteDelta(1, -1)).toEqual({ likes: 1, dislikes: -1 });
  });

  it('clears or repeats a vote', () => {
    expect(voteDelta(0, 1)).toEqual({ likes: -1, dislikes: 0 });
    expect(voteDelta(0, -1)).toEqual({ likes: 0, dislikes: -1 });
    expect(voteDelta(1, 1)).toEqual({ likes: 0, dislikes: 0 });
  });
});
