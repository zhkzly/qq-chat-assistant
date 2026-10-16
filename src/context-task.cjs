'use strict';
// Compatibility facade: timeline policy and derived task projection have one owner.
module.exports={...require('./context/policy.cjs'),...require('./context/timeline-view.cjs'),...require('./context/wording-controls.cjs')};
