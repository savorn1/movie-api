/** {likes, dislikes} change for moving a viewer's vote from `previous` to `vote` (each 1, -1 or 0) */
export function voteDelta(vote: number, previous: number) {
  return {
    likes: (vote === 1 ? 1 : 0) - (previous === 1 ? 1 : 0),
    dislikes: (vote === -1 ? 1 : 0) - (previous === -1 ? 1 : 0),
  };
}
