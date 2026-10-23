import { useState } from 'react';
import { helper } from './helper';
export function View({ n }: { n: number }) {
  const [s] = useState(0);
  return <div>{n > 5 ? helper(s) : null}</div>;
}
