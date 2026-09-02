# multiprocessing over fork: workers are fork children that never exec and
# block on pipes/semaphores, i.e. fork materialisation under a real library
from multiprocessing import Pool
if __name__ == '__main__':
    with Pool(2) as p:
        print(p.map(abs, [-1, -2, -3]))
        print(sum(p.map(pow, [(2, 10), (3, 3)])) if False else sorted(p.map(len, ['a', 'bb', 'ccc'])))
