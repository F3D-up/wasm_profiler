#[no_mangle]
pub extern "C" fn fib(n: i32) -> i32 {
    if n < 2 {
        n
    } else {
        fib(n - 1) + fib(n - 2)
    }
}

#[inline(never)]
fn hot_step(x: f64) -> f64 {
    x.abs().sqrt() + x * 0.5
}

#[no_mangle]
pub extern "C" fn hot_loop(iters: i32) -> f64 {
    let mut acc = 1.2345_f64;
    for _ in 0..iters {
        acc = hot_step(acc) + 0.001;
    }
    acc
}

#[inline(never)]
fn chain_c(n: i32) -> i64 {
    let mut acc = 0_i64;
    for i in 0..n as i64 {
        acc = (acc + i * i) % 1_000_003;
    }
    acc
}

#[inline(never)]
fn chain_b(n: i32) -> i64 {
    chain_c(n) + 1
}

#[no_mangle]
pub extern "C" fn chain_a(n: i32) -> i64 {
    chain_b(n) + 1
}

use std::hint::black_box;

const HEAVY_ITERS: i64 = 4_000_000;
const TINY_CALLS: i64 = 800_000;
const PARENT_ITERS: i64 = 400_000;

#[inline(never)]
fn heavy(iters: i64) -> i64 {
    let mut acc = 0i64;
    for i in 0..iters {
        acc = acc.wrapping_add(black_box(i).wrapping_mul(31).wrapping_add(7));
    }
    acc
}

#[inline(never)]
fn tiny_hot(x: i64) -> i64 {
    black_box(x).wrapping_mul(31).wrapping_add(7)
}

#[inline(never)]
fn rare_brief(x: i64) -> i64 {
    black_box(x) ^ 0xdef_c001
}

#[no_mangle]
#[inline(never)]
pub extern "C" fn work(depth: i32) -> i64 {
    let mut acc = 0i64;
    for i in 0..PARENT_ITERS {
        acc = acc.wrapping_add(black_box(i));
    }
    acc = acc.wrapping_add(heavy(HEAVY_ITERS));
    for i in 0..TINY_CALLS {
        acc = acc.wrapping_add(tiny_hot(i));
    }
    acc = acc.wrapping_add(rare_brief(depth as i64));
    if depth > 0 {
        acc = acc.wrapping_add(work(depth - 1));
    }
    black_box(acc)
}

#[inline(never)]
fn pass_a() -> i64 {
    work(10).wrapping_add(black_box(0xa))
}

#[inline(never)]
fn pass_b() -> i64 {
    work(10).wrapping_add(black_box(0xb))
}

#[inline(never)]
fn pass_c() -> i64 {
    work(10).wrapping_add(black_box(0xc))
}

#[no_mangle]
#[inline(never)]
pub extern "C" fn benchmark() -> i64 {
    let mut acc = 0i64;
    acc = acc.wrapping_add(pass_a());
    acc = acc.wrapping_add(pass_b());
    acc = acc.wrapping_add(pass_c());
    black_box(acc)
}
