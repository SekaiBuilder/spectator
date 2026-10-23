mod util;
use crate::util::double;

pub fn compute(x: i32) -> i32 {
    if x > 10 { double(x) } else { match x { 0 => 1, _ => x } }
}
