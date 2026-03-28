/**
 * Korean/Chinese Lunar Calendar to Solar (Gregorian) Calendar Converter
 * Covers years 1920-2050
 *
 * Data verified against the Korean Astronomical Research Institute (KASI) tables
 * via the korean-lunar-calendar library (github.com/usingsky/korean_lunar_calendar_js).
 *
 * Each year is stored as a 14-element array:
 *   [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12, leapMonth, leapMonthDays]
 *   - m1..m12: days in each regular month (29 or 30)
 *   - leapMonth: which month has a leap (0 = none, 1-12)
 *   - leapMonthDays: days in the leap month (29 or 30, 0 if no leap)
 *
 * Lunar New Year solar dates are stored separately as [month, day] pairs.
 *
 * No external dependencies.
 */

const LUNAR_START_YEAR = 1920;
const LUNAR_END_YEAR = 2050;

// Solar date of Lunar New Year (Lunar 1/1) for each year 1920-2050
// Verified against KASI data
const LUNAR_NEW_YEAR = [
  [2, 20], // 1920
  [2, 8],  // 1921
  [1, 28], // 1922
  [2, 16], // 1923
  [2, 5],  // 1924
  [1, 24], // 1925
  [2, 13], // 1926
  [2, 2],  // 1927
  [1, 23], // 1928
  [2, 10], // 1929
  [1, 30], // 1930
  [2, 17], // 1931
  [2, 6],  // 1932
  [1, 26], // 1933
  [2, 14], // 1934
  [2, 4],  // 1935
  [1, 24], // 1936
  [2, 11], // 1937
  [1, 31], // 1938
  [2, 19], // 1939
  [2, 8],  // 1940
  [1, 27], // 1941
  [2, 15], // 1942
  [2, 5],  // 1943
  [1, 26], // 1944
  [2, 13], // 1945
  [2, 2],  // 1946
  [1, 22], // 1947
  [2, 10], // 1948
  [1, 29], // 1949
  [2, 17], // 1950
  [2, 6],  // 1951
  [1, 27], // 1952
  [2, 14], // 1953
  [2, 4],  // 1954
  [1, 24], // 1955
  [2, 12], // 1956
  [1, 31], // 1957
  [2, 19], // 1958
  [2, 8],  // 1959
  [1, 28], // 1960
  [2, 15], // 1961
  [2, 5],  // 1962
  [1, 25], // 1963
  [2, 13], // 1964
  [2, 2],  // 1965
  [1, 22], // 1966
  [2, 9],  // 1967
  [1, 30], // 1968
  [2, 17], // 1969
  [2, 6],  // 1970
  [1, 27], // 1971
  [2, 15], // 1972
  [2, 3],  // 1973
  [1, 23], // 1974
  [2, 11], // 1975
  [1, 31], // 1976
  [2, 18], // 1977
  [2, 7],  // 1978
  [1, 28], // 1979
  [2, 16], // 1980
  [2, 5],  // 1981
  [1, 25], // 1982
  [2, 13], // 1983
  [2, 2],  // 1984
  [2, 20], // 1985
  [2, 9],  // 1986
  [1, 29], // 1987
  [2, 18], // 1988
  [2, 6],  // 1989
  [1, 27], // 1990
  [2, 15], // 1991
  [2, 4],  // 1992
  [1, 23], // 1993
  [2, 10], // 1994
  [1, 31], // 1995
  [2, 19], // 1996
  [2, 8],  // 1997
  [1, 28], // 1998
  [2, 16], // 1999
  [2, 5],  // 2000
  [1, 24], // 2001
  [2, 12], // 2002
  [2, 1],  // 2003
  [1, 22], // 2004
  [2, 9],  // 2005
  [1, 29], // 2006
  [2, 18], // 2007
  [2, 7],  // 2008
  [1, 26], // 2009
  [2, 14], // 2010
  [2, 3],  // 2011
  [1, 23], // 2012
  [2, 10], // 2013
  [1, 31], // 2014
  [2, 19], // 2015
  [2, 8],  // 2016
  [1, 28], // 2017
  [2, 16], // 2018
  [2, 5],  // 2019
  [1, 25], // 2020
  [2, 12], // 2021
  [2, 1],  // 2022
  [1, 22], // 2023
  [2, 10], // 2024
  [1, 29], // 2025
  [2, 17], // 2026
  [2, 7],  // 2027
  [1, 27], // 2028
  [2, 13], // 2029
  [2, 3],  // 2030
  [1, 23], // 2031
  [2, 11], // 2032
  [1, 31], // 2033
  [2, 19], // 2034
  [2, 8],  // 2035
  [1, 28], // 2036
  [2, 15], // 2037
  [2, 4],  // 2038
  [1, 24], // 2039
  [2, 12], // 2040
  [2, 1],  // 2041
  [1, 22], // 2042
  [2, 10], // 2043
  [1, 30], // 2044
  [2, 17], // 2045
  [2, 6],  // 2046
  [1, 26], // 2047
  [2, 14], // 2048
  [2, 2],  // 2049
  [1, 23]  // 2050
];

/**
 * Lunar year data for 1920-2050.
 * Each entry: [m1..m12 days, leapMonth, leapMonthDays]
 * Data source: Korean Astronomical Research Institute (KASI)
 */
const LUNAR_YEAR_DATA = [
  // 1920: no leap
  [29, 30, 29, 29, 30, 29, 29, 30, 30, 29, 30, 30, 0, 0],
  // 1921: no leap
  [30, 29, 30, 29, 29, 30, 29, 29, 30, 29, 30, 30, 0, 0],
  // 1922: leap 5
  [30, 29, 30, 30, 29, 30, 29, 29, 30, 29, 30, 30, 5, 29],
  // 1923: no leap
  [29, 30, 30, 29, 30, 29, 30, 29, 30, 29, 29, 30, 0, 0],
  // 1924: no leap
  [30, 29, 30, 29, 30, 30, 29, 30, 29, 30, 29, 29, 0, 0],
  // 1925: leap 4
  [30, 29, 30, 30, 30, 29, 30, 30, 29, 30, 29, 30, 4, 29],
  // 1926: no leap
  [29, 29, 30, 29, 30, 29, 30, 30, 29, 30, 30, 29, 0, 0],
  // 1927: no leap
  [30, 29, 29, 30, 29, 30, 29, 30, 30, 29, 30, 30, 0, 0],
  // 1928: leap 2
  [29, 30, 29, 30, 29, 29, 30, 30, 29, 30, 30, 30, 2, 29],
  // 1929: no leap
  [29, 30, 29, 29, 30, 29, 29, 30, 29, 30, 30, 30, 0, 0],
  // 1930: leap 6
  [29, 30, 30, 29, 29, 30, 29, 30, 29, 30, 30, 29, 6, 29],
  // 1931: no leap
  [30, 30, 30, 29, 29, 30, 29, 29, 30, 29, 30, 29, 0, 0],
  // 1932: no leap
  [30, 30, 30, 29, 30, 29, 30, 29, 29, 30, 29, 30, 0, 0],
  // 1933: leap 5
  [29, 30, 30, 29, 30, 29, 30, 29, 30, 29, 29, 30, 5, 30],
  // 1934: no leap
  [29, 30, 29, 30, 30, 29, 30, 30, 29, 30, 29, 30, 0, 0],
  // 1935: no leap
  [29, 29, 30, 29, 30, 29, 30, 30, 29, 30, 30, 29, 0, 0],
  // 1936: leap 3
  [30, 29, 29, 29, 30, 29, 30, 29, 30, 30, 30, 29, 3, 30],
  // 1937: no leap
  [30, 29, 29, 30, 29, 29, 30, 29, 30, 30, 30, 29, 0, 0],
  // 1938: leap 7
  [30, 30, 29, 29, 30, 29, 29, 29, 30, 30, 29, 30, 7, 30],
  // 1939: no leap
  [30, 30, 29, 29, 30, 29, 29, 30, 29, 30, 29, 30, 0, 0],
  // 1940: no leap
  [30, 30, 29, 30, 29, 30, 29, 29, 30, 29, 30, 29, 0, 0],
  // 1941: leap 6
  [30, 30, 29, 30, 30, 29, 29, 29, 30, 29, 30, 29, 6, 30],
  // 1942: no leap
  [30, 29, 30, 30, 29, 30, 30, 29, 30, 29, 29, 30, 0, 0],
  // 1943: no leap
  [29, 30, 29, 30, 29, 30, 30, 29, 30, 30, 29, 30, 0, 0],
  // 1944: leap 4
  [29, 29, 30, 29, 29, 30, 29, 30, 30, 29, 30, 30, 4, 30],
  // 1945: no leap
  [29, 29, 30, 29, 29, 30, 29, 30, 30, 30, 29, 30, 0, 0],
  // 1946: no leap
  [30, 29, 29, 30, 29, 29, 30, 29, 30, 30, 29, 30, 0, 0],
  // 1947: leap 2
  [30, 30, 29, 30, 29, 29, 30, 29, 30, 29, 30, 30, 2, 29],
  // 1948: no leap
  [30, 29, 30, 29, 30, 29, 29, 30, 29, 30, 29, 30, 0, 0],
  // 1949: leap 7
  [30, 30, 29, 30, 29, 30, 29, 30, 29, 30, 29, 30, 7, 29],
  // 1950: no leap
  [30, 29, 30, 30, 29, 30, 29, 29, 30, 29, 30, 29, 0, 0],
  // 1951: no leap
  [30, 29, 30, 30, 29, 30, 29, 30, 29, 30, 29, 30, 0, 0],
  // 1952: leap 5
  [29, 30, 29, 30, 29, 30, 29, 30, 29, 30, 29, 30, 5, 30],
  // 1953: no leap
  [29, 30, 29, 29, 30, 30, 29, 30, 30, 29, 30, 30, 0, 0],
  // 1954: no leap
  [29, 29, 30, 29, 29, 30, 29, 30, 30, 29, 30, 30, 0, 0],
  // 1955: leap 3
  [30, 29, 29, 29, 29, 30, 29, 30, 29, 30, 30, 30, 3, 30],
  // 1956: no leap
  [29, 30, 29, 30, 29, 29, 30, 29, 30, 29, 30, 30, 0, 0],
  // 1957: leap 8
  [30, 29, 30, 29, 30, 29, 29, 30, 30, 29, 30, 30, 8, 29],
  // 1958: no leap
  [29, 30, 30, 29, 30, 29, 29, 30, 29, 30, 29, 30, 0, 0],
  // 1959: no leap
  [29, 30, 30, 29, 30, 29, 30, 29, 30, 29, 30, 29, 0, 0],
  // 1960: leap 6
  [30, 29, 30, 29, 30, 30, 30, 29, 30, 29, 30, 29, 6, 29],
  // 1961: no leap
  [30, 29, 30, 29, 30, 29, 30, 30, 29, 30, 29, 30, 0, 0],
  // 1962: no leap
  [29, 30, 29, 29, 30, 29, 30, 30, 29, 30, 30, 29, 0, 0],
  // 1963: leap 4
  [30, 29, 30, 29, 30, 29, 30, 29, 30, 30, 30, 29, 4, 29],
  // 1964: no leap
  [30, 29, 30, 29, 29, 30, 29, 30, 29, 30, 30, 30, 0, 0],
  // 1965: no leap
  [29, 30, 29, 30, 29, 29, 30, 29, 29, 30, 30, 30, 0, 0],
  // 1966: leap 3
  [29, 30, 30, 30, 29, 29, 30, 29, 29, 30, 30, 29, 3, 29],
  // 1967: no leap
  [30, 30, 29, 30, 30, 29, 29, 30, 29, 30, 29, 30, 0, 0],
  // 1968: leap 7
  [29, 30, 30, 29, 30, 29, 30, 30, 29, 30, 29, 30, 7, 29],
  // 1969: no leap
  [29, 30, 29, 30, 29, 30, 30, 29, 30, 29, 30, 29, 0, 0],
  // 1970: no leap
  [30, 29, 29, 30, 30, 29, 30, 29, 30, 30, 29, 30, 0, 0],
  // 1971: leap 5
  [29, 30, 29, 29, 30, 30, 29, 30, 30, 30, 29, 30, 5, 29],
  // 1972: no leap
  [29, 30, 29, 29, 30, 29, 30, 29, 30, 30, 30, 29, 0, 0],
  // 1973: no leap
  [30, 29, 30, 29, 29, 30, 29, 29, 30, 30, 30, 29, 0, 0],
  // 1974: leap 4
  [30, 30, 29, 30, 29, 30, 29, 29, 30, 30, 29, 30, 4, 29],
  // 1975: no leap
  [30, 30, 29, 30, 29, 29, 30, 29, 29, 30, 29, 30, 0, 0],
  // 1976: leap 8
  [30, 30, 29, 30, 29, 30, 29, 30, 30, 29, 29, 30, 8, 29],
  // 1977: no leap
  [30, 29, 30, 30, 29, 30, 29, 30, 29, 30, 29, 29, 0, 0],
  // 1978: no leap
  [30, 30, 29, 30, 29, 30, 30, 29, 30, 29, 30, 29, 0, 0],
  // 1979: leap 6
  [30, 29, 29, 30, 29, 30, 29, 30, 30, 29, 30, 29, 6, 30],
  // 1980: no leap
  [30, 29, 29, 30, 29, 30, 29, 30, 30, 29, 30, 30, 0, 0],
  // 1981: no leap
  [29, 30, 29, 29, 30, 29, 29, 30, 30, 29, 30, 30, 0, 0],
  // 1982: leap 4
  [30, 29, 30, 29, 30, 29, 29, 30, 30, 29, 30, 30, 4, 29],
  // 1983: no leap
  [30, 29, 30, 29, 29, 30, 29, 29, 30, 29, 30, 30, 0, 0],
  // 1984: leap 10
  [30, 29, 30, 30, 29, 29, 30, 29, 29, 30, 30, 30, 10, 29],
  // 1985: no leap
  [29, 30, 30, 29, 30, 29, 30, 29, 29, 30, 29, 30, 0, 0],
  // 1986: no leap
  [29, 30, 30, 29, 30, 30, 29, 30, 29, 30, 29, 29, 0, 0],
  // 1987: leap 6
  [30, 29, 30, 30, 29, 30, 30, 30, 29, 30, 29, 30, 6, 29],
  // 1988: no leap
  [29, 29, 30, 29, 30, 29, 30, 30, 29, 30, 30, 29, 0, 0],
  // 1989: no leap
  [30, 29, 29, 30, 29, 30, 29, 30, 30, 29, 30, 30, 0, 0],
  // 1990: leap 5
  [29, 30, 29, 29, 30, 29, 30, 30, 29, 30, 30, 30, 5, 29],
  // 1991: no leap
  [29, 30, 29, 29, 30, 29, 29, 30, 29, 30, 30, 30, 0, 0],
  // 1992: no leap
  [29, 30, 30, 29, 29, 30, 29, 29, 30, 29, 30, 30, 0, 0],
  // 1993: leap 3
  [29, 30, 30, 30, 29, 30, 29, 29, 30, 29, 30, 29, 3, 29],
  // 1994: no leap
  [30, 30, 30, 29, 30, 29, 30, 29, 29, 30, 29, 30, 0, 0],
  // 1995: leap 8
  [29, 30, 30, 29, 30, 30, 29, 30, 30, 29, 29, 30, 8, 29],
  // 1996: no leap
  [29, 30, 29, 30, 30, 29, 30, 29, 30, 30, 29, 30, 0, 0],
  // 1997: no leap
  [29, 29, 30, 29, 30, 29, 30, 30, 29, 30, 30, 29, 0, 0],
  // 1998: leap 5
  [30, 29, 29, 30, 29, 30, 30, 29, 30, 30, 30, 29, 5, 29],
  // 1999: no leap
  [30, 29, 29, 30, 29, 29, 30, 29, 30, 30, 30, 29, 0, 0],
  // 2000: no leap
  [30, 30, 29, 29, 30, 29, 29, 30, 29, 30, 30, 29, 0, 0],
  // 2001: leap 4
  [30, 30, 30, 29, 30, 29, 29, 30, 29, 30, 29, 30, 4, 29],
  // 2002: no leap
  [30, 30, 29, 30, 29, 30, 29, 29, 30, 29, 30, 29, 0, 0],
  // 2003: no leap
  [30, 30, 29, 30, 30, 29, 30, 29, 29, 30, 29, 30, 0, 0],
  // 2004: leap 2
  [29, 30, 30, 30, 29, 30, 29, 30, 29, 30, 29, 30, 2, 29],
  // 2005: no leap
  [29, 30, 29, 30, 29, 30, 30, 29, 30, 30, 29, 29, 0, 0],
  // 2006: leap 7
  [30, 29, 30, 29, 30, 29, 30, 30, 30, 29, 30, 30, 7, 29],
  // 2007: no leap
  [29, 29, 30, 29, 29, 30, 29, 30, 30, 30, 29, 30, 0, 0],
  // 2008: no leap
  [30, 29, 29, 30, 29, 29, 30, 29, 30, 30, 29, 30, 0, 0],
  // 2009: leap 5
  [30, 30, 29, 29, 30, 29, 30, 29, 30, 29, 30, 30, 5, 29],
  // 2010: no leap
  [30, 29, 30, 29, 30, 29, 29, 30, 29, 30, 29, 30, 0, 0],
  // 2011: no leap
  [30, 29, 30, 30, 29, 30, 29, 29, 30, 29, 30, 29, 0, 0],
  // 2012: leap 3
  [30, 29, 30, 30, 29, 30, 29, 29, 30, 29, 30, 29, 3, 30],
  // 2013: no leap
  [30, 29, 30, 30, 29, 30, 29, 30, 29, 30, 29, 30, 0, 0],
  // 2014: leap 9
  [29, 30, 29, 30, 29, 30, 29, 30, 30, 30, 29, 30, 9, 29],
  // 2015: no leap
  [29, 30, 29, 29, 30, 29, 30, 30, 30, 29, 30, 29, 0, 0],
  // 2016: no leap
  [30, 29, 30, 29, 29, 30, 29, 30, 30, 29, 30, 30, 0, 0],
  // 2017: leap 5
  [29, 30, 29, 30, 29, 30, 29, 30, 29, 30, 30, 30, 5, 29],
  // 2018: no leap
  [29, 30, 29, 30, 29, 29, 30, 29, 30, 29, 30, 30, 0, 0],
  // 2019: no leap
  [30, 29, 30, 29, 30, 29, 29, 30, 29, 30, 29, 30, 0, 0],
  // 2020: leap 4
  [30, 29, 30, 30, 30, 29, 29, 30, 29, 30, 29, 30, 4, 29],
  // 2021: no leap
  [29, 30, 30, 29, 30, 29, 30, 29, 30, 29, 30, 29, 0, 0],
  // 2022: no leap
  [30, 29, 30, 29, 30, 30, 29, 30, 29, 30, 29, 30, 0, 0],
  // 2023: leap 2
  [29, 30, 30, 29, 30, 29, 30, 30, 29, 30, 29, 30, 2, 29],
  // 2024: no leap
  [29, 30, 29, 29, 30, 29, 30, 30, 29, 30, 30, 29, 0, 0],
  // 2025: leap 6
  [30, 29, 30, 29, 29, 30, 30, 29, 30, 30, 30, 29, 6, 29],
  // 2026: no leap
  [30, 29, 30, 29, 29, 30, 29, 30, 29, 30, 30, 30, 0, 0],
  // 2027: no leap
  [29, 30, 29, 30, 29, 29, 30, 29, 29, 30, 30, 30, 0, 0],
  // 2028: leap 5
  [29, 30, 30, 29, 30, 29, 30, 29, 29, 30, 30, 29, 5, 29],
  // 2029: no leap
  [30, 30, 29, 30, 30, 29, 29, 30, 29, 29, 30, 30, 0, 0],
  // 2030: no leap
  [29, 30, 29, 30, 30, 29, 30, 29, 30, 29, 30, 29, 0, 0],
  // 2031: leap 3
  [30, 29, 30, 30, 29, 30, 30, 29, 30, 29, 30, 29, 3, 29],
  // 2032: no leap
  [30, 29, 29, 30, 29, 30, 30, 29, 30, 30, 29, 30, 0, 0],
  // 2033: leap 11
  [29, 30, 29, 29, 30, 29, 30, 29, 30, 30, 30, 30, 11, 29],
  // 2034: no leap
  [29, 30, 29, 29, 30, 29, 30, 29, 30, 30, 30, 29, 0, 0],
  // 2035: no leap
  [30, 29, 30, 29, 29, 30, 29, 29, 30, 30, 29, 30, 0, 0],
  // 2036: leap 6
  [30, 30, 29, 30, 29, 29, 29, 29, 30, 30, 29, 30, 6, 30],
  // 2037: no leap
  [30, 30, 29, 30, 29, 29, 30, 29, 29, 30, 29, 30, 0, 0],
  // 2038: no leap
  [30, 30, 29, 30, 29, 30, 29, 30, 29, 29, 30, 29, 0, 0],
  // 2039: leap 5
  [30, 30, 29, 30, 30, 30, 29, 30, 29, 30, 29, 29, 5, 29],
  // 2040: no leap
  [30, 29, 30, 30, 29, 30, 30, 29, 30, 29, 30, 29, 0, 0],
  // 2041: no leap
  [30, 29, 29, 30, 29, 30, 30, 29, 30, 30, 29, 30, 0, 0],
  // 2042: leap 2
  [29, 30, 29, 30, 29, 30, 29, 30, 30, 29, 30, 30, 2, 29],
  // 2043: no leap
  [29, 30, 29, 29, 30, 29, 29, 30, 30, 29, 30, 30, 0, 0],
  // 2044: leap 7
  [30, 29, 30, 29, 29, 30, 29, 30, 29, 30, 30, 30, 7, 29],
  // 2045: no leap
  [30, 29, 30, 29, 29, 30, 29, 29, 30, 29, 30, 30, 0, 0],
  // 2046: no leap
  [30, 29, 30, 30, 29, 29, 30, 29, 29, 30, 29, 30, 0, 0],
  // 2047: leap 5
  [30, 29, 30, 30, 29, 29, 30, 29, 29, 30, 29, 30, 5, 30],
  // 2048: no leap
  [29, 30, 30, 29, 30, 30, 29, 30, 29, 30, 29, 29, 0, 0],
  // 2049: no leap
  [30, 29, 30, 29, 30, 30, 29, 30, 30, 29, 30, 29, 0, 0],
  // 2050: leap 3
  [30, 29, 29, 29, 30, 29, 30, 30, 29, 30, 30, 29, 3, 30]
];

/**
 * Get the number of days in a regular (non-leap) lunar month
 * @param {number} year - Lunar year
 * @param {number} month - Month 1-12
 * @returns {number} 29 or 30
 */
function getMonthDays(year, month) {
  return LUNAR_YEAR_DATA[year - LUNAR_START_YEAR][month - 1];
}

/**
 * Get the leap month number for a given lunar year (0 if no leap month)
 * @param {number} year
 * @returns {number}
 */
function getLeapMonth(year) {
  return LUNAR_YEAR_DATA[year - LUNAR_START_YEAR][12];
}

/**
 * Get the number of days in the leap month (0 if no leap month)
 * @param {number} year
 * @returns {number}
 */
function getLeapMonthDays(year) {
  return LUNAR_YEAR_DATA[year - LUNAR_START_YEAR][13];
}

/**
 * Get total days in a lunar year (including leap month if any)
 * @param {number} year
 * @returns {number}
 */
function getLunarYearDays(year) {
  const data = LUNAR_YEAR_DATA[year - LUNAR_START_YEAR];
  let total = 0;
  for (let i = 0; i < 12; i++) {
    total += data[i];
  }
  total += data[13]; // leap month days
  return total;
}

/**
 * Get number of days in a solar month
 */
function getSolarMonthDays(year, month) {
  const days = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) return 29;
  return days[month];
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

/**
 * Add days to a solar date and return the resulting date
 */
function addDaysToSolar(year, month, day, daysToAdd) {
  let y = year, m = month, d = day;
  d += daysToAdd;
  while (d > getSolarMonthDays(y, m)) {
    d -= getSolarMonthDays(y, m);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return { year: y, month: m, day: d };
}

/**
 * Convert a Korean/Chinese lunar calendar date to a solar (Gregorian) date.
 *
 * @param {number} year - Lunar year (1920-2050)
 * @param {number} month - Lunar month (1-12)
 * @param {number} day - Lunar day (1-30)
 * @param {boolean} [isLeapMonth=false] - Whether this is a leap month (윤달)
 * @returns {{year: number, month: number, day: number}|null} Solar date, or null if invalid
 */
function lunarToSolar(year, month, day, isLeapMonth = false) {
  // Validate types
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number') {
    return null;
  }
  // Validate ranges
  if (!Number.isInteger(year) || year < LUNAR_START_YEAR || year > LUNAR_END_YEAR) {
    return null;
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  if (!Number.isInteger(day) || day < 1 || day > 30) {
    return null;
  }

  const leapM = getLeapMonth(year);

  // Validate leap month request
  if (isLeapMonth) {
    if (leapM === 0 || leapM !== month) {
      return null;
    }
    if (day > getLeapMonthDays(year)) {
      return null;
    }
  } else {
    if (day > getMonthDays(year, month)) {
      return null;
    }
  }

  // Calculate days from lunar 1/1 to the target date
  let offset = 0;

  for (let m = 1; m < month; m++) {
    offset += getMonthDays(year, m);
    // If the leap month comes after month m, include it
    if (leapM === m) {
      offset += getLeapMonthDays(year);
    }
  }

  // If the target IS the leap month, add the regular month's days first
  if (isLeapMonth) {
    offset += getMonthDays(year, month);
  }

  // day 1 = 0 additional offset
  offset += day - 1;

  // Get the solar date of Lunar New Year for this year
  const idx = year - LUNAR_START_YEAR;
  const nyMonth = LUNAR_NEW_YEAR[idx][0];
  const nyDay = LUNAR_NEW_YEAR[idx][1];

  return addDaysToSolar(year, nyMonth, nyDay, offset);
}

/**
 * Get information about a lunar year
 * @param {number} year - Lunar year (1920-2050)
 * @returns {{totalDays: number, leapMonth: number, leapMonthDays: number, months: number[]}|null}
 */
function getLunarYearInfo(year) {
  if (year < LUNAR_START_YEAR || year > LUNAR_END_YEAR) {
    return null;
  }
  const data = LUNAR_YEAR_DATA[year - LUNAR_START_YEAR];
  return {
    totalDays: getLunarYearDays(year),
    leapMonth: data[12],
    leapMonthDays: data[13],
    months: data.slice(0, 12)
  };
}

// 해당 음력 년/월에 윤달이 있는지 확인
function hasLeapMonth(year, month) {
  if (year < LUNAR_START_YEAR || year > LUNAR_END_YEAR) return false;
  return getLeapMonth(year) === month;
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { lunarToSolar, getLunarYearInfo, hasLeapMonth };
}
