'use strict';

// CEE is the only upstream provider. This adapter keeps CEE API details out of
// the orchestration engine and returns normalized stream candidates.
function createCeeProvider(resolveStreams) {
  if (typeof resolveStreams !== 'function') throw new TypeError('resolveStreams must be a function');
  return {
    id: 'cee',
    name: 'CEE',
    priority: 100,
    skipTimeoutTimer: true,
    getStreams: function (context) {
      return resolveStreams(context.mediaType, context.id, context.season, context.episode,
        context.suppliedMeta, context.signal, context.deadline);
    }
  };
}

module.exports = { createCeeProvider };
